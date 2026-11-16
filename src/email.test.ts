import { describe, expect, it } from 'vitest';

import { DEFAULT_ACCENT, htmlToText, normaliseAccent, renderEmail, safeHttpsUrl } from './email-layout';
import { alertEmail, flaggedAlert, heldAlert, refusedAlert, shadowAlert } from './alerts';
import { DEFAULT_TEMPLATES, buildCustomerMessage, renderTemplate } from './templates';
import {
    SECRET_MASK, clampTake, maskNotificationSecrets, unmaskNotificationSecrets, validateNotificationConfig, validateTemplateSave,
} from './admin-input';

const brand = { storeName: 'Acme & Co', accentColor: '#AA3300', footerText: 'Acme Ltd, 1 High St\nCompany 123', supportEmail: 'help@acme.test' };

describe('email layout', () => {
    it('renders the shared card with header, accent bar, heading, sign-off and footer', () => {
        const { html, text } = renderEmail({ brand, heading: 'Hello', blocks: [{ type: 'paragraphs', text: 'One\n\nTwo' }] });
        expect(html).toContain('max-width:600px');
        expect(html).toContain('background-color:#f3f4f6');
        expect(html).toContain('border:1px solid #e5e7eb;border-radius:10px');
        expect(html).toContain('border-bottom:3px solid #aa3300');
        expect(html).toContain('font-size:22px');
        expect(html).toContain('Acme &amp; Co');
        expect(html).toContain('Kind regards,');
        expect(html).toContain('mailto:help@acme.test');
        expect(html).toContain('Acme Ltd, 1 High St<br>Company 123');
        expect(html).not.toMatch(/<style/i);
        expect(text).toContain('Hello\n\nOne\n\nTwo');
        expect(text).toContain('Kind regards,\nAcme & Co\nhelp@acme.test');
        expect(text).toContain('Acme Ltd, 1 High St');
    });

    it('escapes every interpolated value', () => {
        const { html } = renderEmail({
            brand: { storeName: '<b>x</b>' },
            heading: '<script>alert(1)</script>',
            blocks: [
                { type: 'paragraphs', text: '<img src=x onerror=alert(1)>' },
                { type: 'info', rows: [{ label: '<i>L</i>', value: '"><svg>', mono: true }] },
                { type: 'warning', title: '<u>', text: '<a>' },
                { type: 'list', items: ['<li>'] },
                { type: 'button', url: 'https://x.test/?a="b"', label: '<b>Go</b>' },
            ],
        });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('"><svg>');
        expect(html).not.toContain('<b>x</b>');
        expect(html).not.toContain('<b>Go</b>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('validates the accent colour and only accepts https logos', () => {
        expect(normaliseAccent('#ABC')).toBe('#abc');
        expect(normaliseAccent('#123456')).toBe('#123456');
        expect(normaliseAccent('red')).toBe(DEFAULT_ACCENT);
        expect(normaliseAccent('#12345g')).toBe(DEFAULT_ACCENT);
        expect(normaliseAccent('#fff;background:url(x)')).toBe(DEFAULT_ACCENT);
        expect(safeHttpsUrl('http://x.test/logo.png')).toBe('');
        expect(safeHttpsUrl('javascript:alert(1)')).toBe('');
        expect(safeHttpsUrl('https://x.test/logo.png')).toBe('https://x.test/logo.png');
        const withLogo = renderEmail({ brand: { storeName: 'S', logoUrl: 'https://x.test/l.png', logoWidth: 999 }, blocks: [] }).html;
        expect(withLogo).toContain('<img src="https://x.test/l.png"');
        expect(withLogo).toContain('width="400"');
        const httpLogo = renderEmail({ brand: { storeName: 'S', logoUrl: 'http://x.test/l.png' }, blocks: [] }).html;
        expect(httpLogo).not.toContain('<img');
        expect(httpLogo).toContain('font-weight:bold;color:#111827;">S</span>');
    });

    it('drops non-http buttons and puts button links in the text version', () => {
        const bad = renderEmail({ brand, blocks: [{ type: 'button', url: 'javascript:alert(1)', label: 'Go' }] });
        expect(bad.html).not.toContain('javascript:');
        const ok = renderEmail({ brand, blocks: [{ type: 'button', url: 'https://x.test/a', label: 'Open', secondary: true }] });
        expect(ok.html).toContain('border:2px solid #aa3300;color:#aa3300');
        expect(ok.text).toContain('Open: https://x.test/a');
    });

    it('turns HTML into readable text', () => {
        expect(htmlToText('<p>Hi &amp; <strong>bye</strong></p><p><a href="https://x.test">site</a></p><ul><li>a</li></ul>'))
            .toBe('Hi & bye\n\nsite (https://x.test)\n\n- a');
    });
});

describe('customer notices', () => {
    const vars = { orderCode: 'ABC123', firstName: 'Sam', supportEmail: 'help@acme.test', reviewHours: 24 };

    it('wraps a plain-text template in the layout with an order box and a text alternative', () => {
        const m = buildCustomerMessage('held', DEFAULT_TEMPLATES.held, vars, brand);
        expect(m.subject).toBe('A quick security check on your order ABC123');
        expect(m.html).toContain('We are checking your order');
        expect(m.html).toContain('ABC123');
        expect(m.html).toContain('font-family:Consolas');
        expect(m.text).toContain('Hi Sam,');
        expect(m.text).toContain('Order: ABC123');
        expect(m.text).not.toMatch(/<[a-z]/i);
    });

    it('escapes variables inside an HTML template body (a name cannot become markup)', () => {
        const m = buildCustomerMessage('approved', { subject: 'Hi {{firstName}}', body: '<p>Hello <strong>{{firstName}}</strong></p>' },
            { ...vars, firstName: '<img src=x onerror=alert(1)>' }, brand);
        expect(m.html).toContain('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
        expect(m.html).not.toContain('<img src=x');
        expect(m.subject).toBe('Hi');
        expect(m.text).toContain('Hello <img src=x onerror=alert(1)>');
    });

    it('escapes a plain-text body as a whole', () => {
        const m = buildCustomerMessage('rejected', { subject: 'S', body: 'Dear {{firstName}}' }, { ...vars, firstName: '<b>x</b>' }, brand);
        expect(m.html).toContain('Dear &lt;b&gt;x&lt;/b&gt;');
    });

    it('keeps the {{var}} renderer behaviour for unknown variables', () => {
        expect(renderTemplate('a {{nope}} b {{ orderCode }}', vars)).toBe('a  b ABC123');
    });

    it('default copy is British English without unsupported claims', () => {
        const all = Object.values(DEFAULT_TEMPLATES).map(t => t.subject + t.body).join('\n');
        expect(all).not.toMatch(/business days|keep prices down|\bemail\b/);
    });
});

describe('admin alerts', () => {
    const evil = { orderCode: '<script>x</script>', orderId: 5, email: '"><img src=x>', score: 80, level: 'high',
        signals: [{ label: '<b>Velocity</b>', points: 30, detail: '<i>3 orders</i>' }] };

    it('escapes order code, e-mail and signals in every alert (shadow, flagged, held, refused)', () => {
        const contents = [
            shadowAlert(evil),
            flaggedAlert({ ...evil, mode: 'monitor', baseUrl: 'https://shop.test/' }),
            heldAlert({ ...evil, block: true, baseUrl: 'https://shop.test' }),
            refusedAlert({ ...evil, amount: '£10.00', reason: 'block-level' }),
        ];
        for (const c of contents) {
            const { html, text } = alertEmail(c, brand);
            expect(html).not.toContain('<script>');
            expect(html).not.toContain('<img src=x>');
            expect(html).not.toContain('<b>Velocity</b>');
            expect(html).toContain('&lt;script&gt;');
            expect(html).toContain('font-size:18px');
            expect(html).not.toContain('Kind regards');
            expect(text).toContain('Velocity');
        }
    });

    it('links to the order and the review queue', () => {
        expect(alertEmail(flaggedAlert({ ...evil, mode: 'monitor', baseUrl: 'https://shop.test/' }), brand).html)
            .toContain('href="https://shop.test/admin/orders/5"');
        expect(alertEmail(heldAlert({ ...evil, block: false, baseUrl: 'https://shop.test' }), brand).text)
            .toContain('Review the case: https://shop.test/admin/extensions/fraud-prevention');
        expect(alertEmail(heldAlert({ ...evil, block: false }), brand).html).not.toContain('Review the case');
    });

    it('refused alert names the reason', () => {
        const t = alertEmail(refusedAlert({ ...evil, amount: '£10.00', reason: 'failed-payment-cooldown' }), brand).text;
        expect(t).toContain('Reason: Failed-payment cooldown');
        expect(t).toContain('No payment was taken.');
    });
});

describe('admin input', () => {
    const stored = { adminEmail: 'a@b.test', slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x', telegramBotToken: '1:abc', genericWebhookSecret: '', discordWebhookUrl: '', teamsWebhookUrl: '' };

    it('masks credentials in GET and keeps them when the mask comes back', () => {
        const masked = maskNotificationSecrets(stored);
        expect(masked.slackWebhookUrl).toBe(SECRET_MASK);
        expect(masked.telegramBotToken).toBe(SECRET_MASK);
        expect(masked.genericWebhookSecret).toBe('');
        expect(masked.adminEmail).toBe('a@b.test');
        const saved = unmaskNotificationSecrets({ ...masked, telegramBotToken: '2:new' }, stored);
        expect(saved.slackWebhookUrl).toBe(stored.slackWebhookUrl);
        expect(saved.telegramBotToken).toBe('2:new');
        expect(unmaskNotificationSecrets({ slackWebhookUrl: '' }, stored).slackWebhookUrl).toBe('');
    });

    it('validates the notification settings', () => {
        expect(validateNotificationConfig({ adminEmail: 'a@b.test, c@d.test' })).toBeNull();
        expect(validateNotificationConfig({ adminEmail: 'not an email' })).toMatch(/not valid/);
        expect(validateNotificationConfig({ slackWebhookUrl: 'http://hooks.slack.com/x' })).toMatch(/https/);
        expect(validateNotificationConfig({ slackWebhookUrl: SECRET_MASK })).toBeNull();
        expect(validateNotificationConfig({ genericWebhookSecret: 'x'.repeat(501) })).toMatch(/too long/);
    });

    it('validates customer-message saves', () => {
        expect(validateTemplateSave({ kind: 'held', channelId: 1, subject: 'S', body: 'B' })).toBeNull();
        expect(validateTemplateSave({ kind: 'held', channelId: 1, reset: true })).toBeNull();
        expect(validateTemplateSave(null)).toMatch(/kind/);
        expect(validateTemplateSave({ kind: 'nope', channelId: 1 })).toMatch(/kind/);
        expect(validateTemplateSave({ kind: 'held', subject: 'S', body: 'B' })).toMatch(/channel/);
        expect(validateTemplateSave({ kind: 'held', channelId: 1, subject: ' ', body: 'B' })).toMatch(/subject/);
        expect(validateTemplateSave({ kind: 'held', channelId: 1, subject: 'S', body: '' })).toMatch(/message/);
    });

    it('clamps list limits', () => {
        expect(clampTake('abc')).toBe(100);
        expect(clampTake(-5)).toBe(100);
        expect(clampTake('20')).toBe(20);
        expect(clampTake(10_000)).toBe(500);
    });
});
