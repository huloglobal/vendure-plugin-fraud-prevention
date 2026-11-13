import * as https from 'https';
import { isIP } from 'net';
import { Logger } from '@vendure/core';
import { isPublicIp } from './net-util';

const loggerCtx = 'FraudPrevention';

export interface IpIntel {
    ip: string;
    countryCode: string | null;
    isVpnOrProxy: boolean;
    isHosting: boolean;
    /** False when the lookup failed — callers must fail open. */
    resolved: boolean;
}

/**
 * IP intelligence from ip-api.com **Pro** over HTTPS with the merchant's own
 * key. Opt-in: nothing is looked up unless IP intelligence is switched on
 * and a key is set (the free ip-api.com endpoint forbids commercial use and
 * is never called). Private, loopback and reserved addresses are never sent.
 * Results are cached by the service in `fraud_ip_intel` for 30 days. Lookups
 * fail OPEN: a timeout or error never adds points and never blocks an order.
 */
const negativeCache = new Map<string, number>();
const NEGATIVE_TTL = 15 * 60 * 1000;
// Token bucket: 40 lookups per minute, refilled continuously.
let tokens = 40;
let lastRefill = Date.now();
function takeToken(): boolean {
    const now = Date.now();
    tokens = Math.min(40, tokens + ((now - lastRefill) / 60_000) * 40);
    lastRefill = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
}
/** Test hook. */
export function _resetIpIntelState() { negativeCache.clear(); tokens = 40; lastRefill = Date.now(); }

export interface IpIntelLookupOptions {
    /** ip-api.com Pro key; empty = no lookup. */
    apiKey?: string | null;
    timeoutMs?: number;
    /** Test hook: replaces the HTTPS GET. Resolves with the response body. */
    get?: (url: string, timeoutMs: number) => Promise<string>;
}

/** The request URL (exported for tests). The key travels as a query
 *  parameter, as ip-api.com Pro requires; it is never logged. */
export function ipApiUrl(ip: string, apiKey: string): string {
    return `https://pro.ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,proxy,hosting&key=${encodeURIComponent(apiKey)}`;
}

function httpsGet(url: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, res => {
            if ((res.statusCode || 0) !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => { data += c; if (data.length > 64_000) req.destroy(new Error('response too large')); });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}

export async function lookupIpIntel(ip: string, opts: IpIntelLookupOptions = {}): Promise<IpIntel> {
    const empty: IpIntel = { ip, countryCode: null, isVpnOrProxy: false, isHosting: false, resolved: false };
    const key = String(opts.apiKey || '').trim();
    if (!key || !isIP(ip) || !isPublicIp(ip)) return empty;
    // A lookup that failed (timeout, rate limit, bad answer) is remembered for a while so a wave
    // of orders from new addresses does not pay the full timeout each.
    const neg = negativeCache.get(ip);
    if (neg && Date.now() - neg < NEGATIVE_TTL) return empty;
    if (!takeToken()) return empty;
    const timeoutMs = opts.timeoutMs ?? 2500;
    try {
        const body = await (opts.get ?? httpsGet)(ipApiUrl(ip, key), timeoutMs);
        const j = JSON.parse(body);
        if (j?.status !== 'success') { negativeCache.set(ip, Date.now()); return empty; }
        return {
            ip,
            countryCode: typeof j.countryCode === 'string' && j.countryCode ? j.countryCode : null,
            isVpnOrProxy: !!j.proxy,
            isHosting: !!j.hosting,
            resolved: true,
        };
    } catch (e: any) {
        // The message never includes the URL (and so never the key).
        Logger.debug(`ip-intel lookup failed for ${ip}: ${e?.message || e}`, loggerCtx);
        negativeCache.set(ip, Date.now());
        if (negativeCache.size > 10_000) negativeCache.delete(negativeCache.keys().next().value as string);
        return empty;
    }
}

// ── Email MX validation ─────────────────────────────────────────────
// A domain with no MX records can't receive the licence-key email —
// classic throwaway checkout address. In-memory cache with 24h TTL;
// DNS failures (as opposed to authoritative empty answers) fail open.

const mxCache = new Map<string, { hasMx: boolean; at: number }>();
const MX_TTL = 24 * 3600 * 1000;

export async function domainHasMx(domain: string, timeoutMs = 3000): Promise<boolean | null> {
    const hit = mxCache.get(domain);
    if (hit && Date.now() - hit.at < MX_TTL) return hit.hasMx;
    try {
        const dns = await import('dns');
        const records = await Promise.race([
            dns.promises.resolveMx(domain),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
        ]);
        const hasMx = Array.isArray(records) && records.length > 0;
        mxCache.set(domain, { hasMx, at: Date.now() });
        if (mxCache.size > 10_000) mxCache.delete(mxCache.keys().next().value as string);
        return hasMx;
    } catch (e: any) {
        // ENOTFOUND / ENODATA are authoritative "this domain can't receive
        // mail"; anything else (timeout, SERVFAIL) is unknown -> fail open.
        if (e?.code === 'ENOTFOUND' || e?.code === 'ENODATA') {
            mxCache.set(domain, { hasMx: false, at: Date.now() });
            return false;
        }
        return null;
    }
}

/** Heuristic for keyboard-mash local parts (xk49281@, asdkjhqw@).
 *  Deliberately weak on its own — it only matters in combination. */
export function looksGibberish(localPart: string): boolean {
    const lp = localPart.toLowerCase().replace(/[._-]/g, '');
    if (lp.length < 6) return false;
    // 0.6 not 0.5 — "john1985"-style birth-year suffixes are normal and
    // sit exactly at half digits.
    const digits = (lp.match(/\d/g) || []).length;
    if (digits / lp.length >= 0.6) return true;
    const consonantRun = lp.match(/[bcdfghjklmnpqrstvwxz]{6,}/);
    return !!consonantRun;
}
