/**
 * PostgreSQL corpus check — runs only when HULO_PG_URL points at a scratch
 * database (e.g. postgres://hulo_pg:hulo_pg_local@localhost:5432/hulo_fp_pg).
 *
 * Every SQL template literal in src/ is extracted with the TypeScript
 * parser, its interpolations replaced by representative fragments, the
 * statement translated by the licence-sdk dialect adapter and then run
 * against Postgres: DDL is executed (the plugin's own tables plus quoted
 * camelCase stand-ins for the Vendure tables the plugin reads), and every
 * other statement is PREPAREd, which makes Postgres resolve each table,
 * column, function and parameter type exactly as it would at runtime.
 * The whole schema is dropped and recreated on each run.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createDbAdapter, translateSql } from '@huloglobal/vendure-licence-sdk';

const PG_URL = process.env.HULO_PG_URL;
const run = PG_URL ? describe : describe.skip;

/** Vendure/TypeORM-owned tables the plugin queries, as Postgres creates them (quoted camelCase). */
const VENDURE_STAND_INS = [
    `CREATE TABLE channel ("id" SERIAL PRIMARY KEY, "code" VARCHAR(255), "token" VARCHAR(255), "defaultLanguageCode" VARCHAR(255), "defaultCurrencyCode" VARCHAR(255))`,
    `CREATE TABLE customer ("id" SERIAL PRIMARY KEY, "firstName" VARCHAR(255), "lastName" VARCHAR(255), "emailAddress" VARCHAR(255), "phoneNumber" VARCHAR(255), "title" VARCHAR(255), "userId" INT, "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP, "deletedAt" TIMESTAMP)`,
    `CREATE TABLE address ("id" SERIAL PRIMARY KEY, "customerId" INT, "company" VARCHAR(255), "streetLine1" VARCHAR(255), "postalCode" VARCHAR(255), "countryCode" VARCHAR(255))`,
    `CREATE TABLE "order" ("id" SERIAL PRIMARY KEY, "code" VARCHAR(255), "state" VARCHAR(255), "active" BOOLEAN, "customerId" INT, "orderPlacedAt" TIMESTAMP, "subTotalWithTax" INT, "totalWithTax" INT, "currencyCode" VARCHAR(255), "customFieldsIp" VARCHAR(255), "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP)`,
    `CREATE TABLE order_channels_channel ("orderId" INT, "channelId" INT, PRIMARY KEY ("orderId", "channelId"))`,
    `CREATE TABLE payment ("id" SERIAL PRIMARY KEY, "orderId" INT, "state" VARCHAR(255), "method" VARCHAR(255), "amount" INT, "transactionId" VARCHAR(255), "errorMessage" VARCHAR(255), "metadata" TEXT, "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP)`,
    `CREATE TABLE product_variant ("id" SERIAL PRIMARY KEY, "sku" VARCHAR(255), "enabled" BOOLEAN, "productId" INT, "deletedAt" TIMESTAMP)`,
    // Another HULO plugin's raw-DDL table (unquoted, so lowercase on Postgres), read when it exists.
    `CREATE TABLE checkout_guard_payment_event (id SERIAL PRIMARY KEY, ip VARCHAR(64), kind VARCHAR(32), createdAt TIMESTAMP)`,
];

/** Representative fragments for the template interpolations the corpus uses (keyed by expression text). */
const INTERPOLATIONS: Record<string, string | string[]> = {
    col: ['discordWebhookUrl VARCHAR(512)', 'teamsWebhookUrl VARCHAR(512)', 'telegramBotToken VARCHAR(128)', 'telegramChatId VARCHAR(64)', 'genericWebhookUrl VARCHAR(512)', 'genericWebhookSecret VARCHAR(128)'],
    placeholders: "(?, ?, ?, '', NOW(), NOW())",
    ph: '?',
    where: '',
    mins: '60',
    schemaExpr: 'current_schema()',
    FEED_SYNC_LOCK_KEY: '5211883387260327236',
    "clauses.join(' AND ')": 'action IS NOT NULL',
    "sets.join(', ')": 'updatedAt = NOW()',
    extra: ' AND o.id <> ? AND o.`currencyCode` = ?',
    exclude: ' AND (l.orderId IS NULL OR l.orderId <> ?)',
};

const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/;
/** Statements on a MySQL-only code path (the Postgres branch beside them is what runs there). */
const MYSQL_ONLY = /\b(GET_LOCK|RELEASE_LOCK)\s*\(/;

interface Statement { where: string; sql: string; conflictColumns?: string[] }

/** Every SQL template literal under src/ (tests excluded), interpolations substituted. */
function extractCorpus(srcDir: string): { statements: Statement[]; unknown: string[] } {
    const statements: Statement[] = [];
    const unknown = new Set<string>();
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) files.push(p);
        }
    };
    walk(srcDir);
    const fragment = (expr: string): string | string[] => {
        if (expr in INTERPOLATIONS) return INTERPOLATIONS[expr];
        const m = expr.match(/\.map\(\(\)\s*=>\s*(['`])(.*?)\1\)\.join\(/);
        if (m) return m[2];
        const branches = expr.match(/\?\s*(.+?)\s*:\s*(.+)$/);
        if (branches) {
            for (const b of [branches[1], branches[2]]) {
                const lit = b.trim().match(/^'([^']*)'$/);
                if (lit) return lit[1];
            }
        }
        if (/^Math\.(min|max)\(|^\d+$/.test(expr)) return '20';
        unknown.add(expr);
        return '';
    };
    for (const file of files) {
        const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2020, true);
        const where = (n: ts.Node) => `${path.basename(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        const conflictColumnsFor = (n: ts.Node): string[] | undefined => {
            const call = n.parent;
            if (!call || !ts.isCallExpression(call)) return undefined;
            const m = call.arguments.map(a => a.getText(sf)).join(',').match(/conflictColumns:\s*\[([^\]]*)\]/);
            return m ? m[1].split(',').map(s => s.trim().replace(/['"`]/g, '')).filter(Boolean) : undefined;
        };
        const visit = (node: ts.Node) => {
            if (ts.isNoSubstitutionTemplateLiteral(node) && SQL_START.test(node.text)) {
                statements.push({ where: where(node), sql: node.text, conflictColumns: conflictColumnsFor(node) });
            } else if (ts.isTemplateExpression(node) && SQL_START.test(node.head.text)) {
                // An array fragment (a loop over column definitions) yields one statement per value.
                let variants = [node.head.text];
                for (const span of node.templateSpans) {
                    const frag = fragment(span.expression.getText(sf));
                    const options = Array.isArray(frag) ? frag : [frag];
                    variants = variants.flatMap(prefix => options.map(o => prefix + o + span.literal.text));
                }
                for (const sql of variants) statements.push({ where: where(node), sql, conflictColumns: conflictColumnsFor(node) });
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return { statements, unknown: [...unknown] };
}

const isDdl = (sql: string) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql);

run('PostgreSQL corpus (HULO_PG_URL)', () => {
    it('every SQL statement in src/ is valid on Postgres', async () => {
        const { Client } = await import('pg');
        const client = new Client({ connectionString: PG_URL });
        await client.connect();
        const failures: string[] = [];
        try {
            await client.query('DROP SCHEMA public CASCADE');
            await client.query('CREATE SCHEMA public');
            for (const ddl of VENDURE_STAND_INS) await client.query(ddl);

            const { statements, unknown } = extractCorpus(path.join(__dirname, '..', 'src'));
            expect(unknown, `add INTERPOLATIONS entries for: ${unknown.join(' | ')}`).toEqual([]);
            expect(statements.length).toBeGreaterThan(100);

            const adapter = createDbAdapter({
                options: { type: 'postgres' },
                query: async (sql: string, params?: any[]) => (await client.query(sql, params)).rows,
            });
            // DDL first, in source order (ensureSchema is the first method), so the DML below can resolve columns.
            // A plain CREATE INDEX that is the try/catch fallback of an IF NOT EXISTS form legitimately reports
            // "already exists" (42P07); everything else must run clean.
            for (const s of statements.filter(s => isDdl(s.sql))) {
                try { await adapter.query(s.sql, [], s.conflictColumns ? { conflictColumns: s.conflictColumns } : undefined); }
                catch (e: any) {
                    if (e.code === '42P07' && !/IF NOT EXISTS/i.test(s.sql)) continue;
                    failures.push(`${s.where}: ${e.message}\n    ${s.sql.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
                }
            }
            let n = 0;
            for (const s of statements.filter(s => !isDdl(s.sql) && !MYSQL_ONLY.test(s.sql))) {
                const translated = translateSql(s.sql, 'postgres', s.conflictColumns ? { conflictColumns: s.conflictColumns } : undefined);
                const name = `corpus_${++n}`;
                try { await client.query(`PREPARE ${name} AS ${translated}`); await client.query(`DEALLOCATE ${name}`); }
                catch (e: any) { failures.push(`${s.where}: ${e.message}\n    ${translated.trim().replace(/\s+/g, ' ').slice(0, 200)}`); }
            }
            // eslint-disable-next-line no-console
            console.log(`PG corpus: ${statements.length} statements (${statements.filter(s => isDdl(s.sql)).length} DDL), ${failures.length} failures`);
        } finally {
            await client.end();
        }
        expect(failures, failures.join('\n')).toEqual([]);
    }, 60_000);
});

/**
 * Behaviour of the queries added in 0.21.0, run through the service itself on
 * Postgres: the fulfilment gate honouring "Hold fulfilment", unplaced attempts
 * (refused / unpaid) that never make an order "assessed", the failed-payment
 * cooldown, the orders-list risk lookup, channel currency and unpaid scoring.
 */
run('PostgreSQL behaviour (HULO_PG_URL)', () => {
    it('gate, unplaced attempts, cooldown, risk column, currency and unpaid scoring work on Postgres', async () => {
        const { Client } = await import('pg');
        const { FraudPreventionService } = await import('../src/fraud-prevention.service');
        const client = new Client({ connectionString: PG_URL });
        await client.connect();
        try {
            await client.query('DROP SCHEMA public CASCADE');
            await client.query('CREATE SCHEMA public');
            for (const ddl of VENDURE_STAND_INS) await client.query(ddl);
            const rawConnection = { options: { type: 'postgres' }, query: async (sql: string, params?: any[]) => (await client.query(sql, params)).rows };
            const svc = new FraudPreventionService({ rawConnection } as any, {} as any, {} as any, { publish: () => undefined } as any);
            await svc.onModuleInit();

            await client.query(`INSERT INTO channel ("id", "code", "token", "defaultCurrencyCode") VALUES (1, 'default', 't1', 'EUR'), (2, 'b2b', 't2', 'JPY')`);
            const cfg1 = await svc.getConfig(1);
            expect(cfg1.currencyCode).toBe('EUR');
            const cfg2 = await svc.getConfig(2);
            expect(cfg2.currencyCode).toBe('JPY');
            expect(cfg2.maxOrderValuePence).toBe(500_000 * 200); // defaults scaled to yen
            await svc.saveConfig({ ...cfg1, holdFulfilment: false, cooldownMinutesAfterFailedPayment: 15, maxFailedPaymentsPerIpPerHour: 3 });

            const a = { score: 80, level: 'blocked' as const, signals: [], allowlisted: false, action: 'block' as const, mode: 'enforce' as const };
            await svc.createCase({ channelId: 1, orderId: 10, orderCode: 'C10', orderValuePence: 100 }, a);
            await svc.createCase({ channelId: 2, orderId: 11, orderCode: 'C11', orderValuePence: 100 }, a);
            const c13 = await svc.createCase({ channelId: 1, orderId: 13, orderCode: 'C13', orderValuePence: 100 }, a);
            await client.query(`UPDATE fraud_blocked_orders SET status = 'rejected' WHERE id = $1`, [c13]);

            expect((await svc.pendingOrderIds()).sort()).toEqual([11]);
            expect((await svc.heldOrderIds()).sort()).toEqual([11, 13]);
            let gate = await svc.fulfilmentGate(10);
            expect(gate).toMatchObject({ assessed: false, held: false, caseStatus: 'pending', releasable: false });
            await svc.logAssessment({ channelId: 1, orderId: 10, orderCode: 'C10', ip: '8.8.8.8', orderValuePence: 100 }, { ...a, action: 'review' });
            gate = await svc.fulfilmentGate(10);
            expect(gate.releasable).toBe(true);
            expect((await svc.fulfilmentGate(11)).held).toBe(true);
            expect((await svc.fulfilmentGate(13)).held).toBe(true);

            // A refused attempt counts for velocity but never makes the order "assessed".
            await svc.logAssessment({ channelId: 1, orderId: 12, orderCode: 'C12', ip: '8.8.8.8', orderValuePence: 100 }, a, 'refused');
            expect(await svc.isAssessed(12)).toBe(false);
            expect(await svc.assessedOrderIds([10, 12])).toEqual([10]);
            expect(await (svc as any).unplacedAttemptsByIp('8.8.8.8')).toEqual({ hour: 1, day: 1 });
            expect(await (svc as any).unplacedAttemptsByIp('8.8.8.8', 12)).toEqual({ hour: 0, day: 0 });

            const risk = await svc.orderRisk([10, 12, 99]);
            expect(risk['10']).toMatchObject({ score: 80, action: 'review', caseStatus: 'pending' });
            expect(risk['12']).toMatchObject({ action: 'refused' });
            expect(risk['99']).toBeUndefined();

            // Failed-payment cooldown: three declines from one address, the latest just now.
            await client.query(`INSERT INTO "order" ("id", "code", "state", "active", "customFieldsIp", "createdAt", "updatedAt") VALUES (20, 'C20', 'ArrangingPayment', true, '8.8.4.4', NOW(), NOW())`);
            for (let i = 0; i < 3; i++) await client.query(`INSERT INTO payment ("orderId", "state", "method", "amount", "createdAt", "updatedAt") VALUES (20, 'Declined', 'card', 100, NOW() - interval '${i * 5} minutes', NOW())`);
            const fp = await svc.failedPaymentState('8.8.4.4', await svc.getConfig(1));
            expect(fp).toMatchObject({ hour: 3, window: 3, coolingDown: true });
            const none = await svc.failedPaymentState('8.8.4.4', { ...(await svc.getConfig(1)), cooldownMinutesAfterFailedPayment: 0 });
            expect(none.coolingDown).toBe(false);

            // An order left in ArrangingPayment past the grace is scored once, as 'unpaid'.
            await client.query(`INSERT INTO customer ("id", "emailAddress") VALUES (1, 'buyer@example.com')`);
            await client.query(`INSERT INTO "order" ("id", "code", "state", "active", "customerId", "subTotalWithTax", "currencyCode", "customFieldsIp", "createdAt", "updatedAt")
                                VALUES (30, 'C30', 'ArrangingPayment', true, 1, 4200, 'EUR', '1.1.1.1', NOW() - interval '40 minutes', NOW() - interval '20 minutes')`);
            await client.query(`INSERT INTO order_channels_channel ("orderId", "channelId") VALUES (30, 1)`);
            expect(await svc.scoreUnpaidOrders()).toBe(1);
            expect(await svc.scoreUnpaidOrders()).toBe(0);
            const { rows } = await client.query(`SELECT action, ordercode FROM fraud_log WHERE orderid = 30`);
            expect(rows).toEqual([{ action: 'unpaid', ordercode: 'C30' }]);
            expect(await svc.isAssessed(30)).toBe(false);

            // Settings live in hulo_plugin_prefs; the key is never returned.
            const st = await svc.saveGeneralSettings({ ipIntelEnabled: true, ipIntelKey: 'abcdef123456', logRetentionDays: 30 });
            expect(st).toMatchObject({ ipIntelEnabled: true, ipIntelKeySet: true, ipIntelKeyHint: '…3456', logRetentionDays: 30 });
            expect(JSON.stringify(st)).not.toContain('abcdef123456');
            expect(await svc.effectiveRetentionDays()).toBe(30);
        } finally {
            await client.end();
        }
    }, 60_000);
});
