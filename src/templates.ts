/**
 * Customer-facing message templates for the three gating outcomes.
 *
 * Stored per channel (multi-storefront installs speak with different
 * voices), edited in the admin Settings tab, rendered with simple
 * {{variable}} substitution. Bodies are plain text — blank lines become
 * paragraphs — so an admin can't break their own email with half-closed
 * HTML, and the tone stays theirs.
 *
 * The defaults are written to be honest without being alarming: a held
 * order is "a quick security check", never "suspected fraud" — the
 * overwhelming majority of held orders are legitimate customers who
 * tripped a velocity rule.
 */

import { EmailBlock, EmailBrand, escapeHtml, renderEmail } from './email-layout';

export type MessageKind = 'held' | 'approved' | 'rejected';

export interface MessageTemplate {
    subject: string;
    body: string;
}

export const TEMPLATE_VARS: Array<{ name: string; description: string }> = [
    { name: 'orderCode', description: 'The order code, e.g. Q6Y23UJU2BM3JHX8' },
    { name: 'firstName', description: "Customer's first name (falls back to 'there')" },
    { name: 'supportEmail', description: 'Your support address (from notification settings)' },
    { name: 'reviewHours', description: 'Expected review turnaround in hours (from channel settings)' },
];

export const DEFAULT_TEMPLATES: Record<MessageKind, MessageTemplate> = {
    held: {
        subject: 'A quick security check on your order {{orderCode}}',
        body: `Hi {{firstName}},

Thanks for your order {{orderCode}} — we've received it and your payment is safe.

As part of our standard security checks, this order has been picked for a quick manual review. This happens routinely and usually means nothing more than an unusually large order or a new address. No action is needed from you.

A member of our team will complete the review within {{reviewHours}} hours (usually much sooner), and your order will be on its way the moment it clears.

If you'd like to speed things up or have any questions, just reply to this e-mail or contact {{supportEmail}} — a short note confirming your order details is often all we need.`,
    },
    approved: {
        subject: 'Your order {{orderCode}} is confirmed and on its way',
        body: `Hi {{firstName}},

Good news — the security check on your order {{orderCode}} is complete and everything is confirmed. Your order is being fulfilled right now.

Thank you for bearing with us; we appreciate your patience.

If anything doesn't arrive as expected, contact us at {{supportEmail}} and we'll sort it straight away.`,
    },
    rejected: {
        subject: 'About your order {{orderCode}}',
        body: `Hi {{firstName}},

Unfortunately we weren't able to complete your order {{orderCode}} after our security review, and it has been cancelled. If a payment was taken, it is refunded to the original payment method; refunds usually appear within 3 to 5 working days.

Security reviews can occasionally catch genuine orders. If you believe this is a mistake, we'd genuinely like to fix it: reply to this e-mail or contact {{supportEmail}} with your order details and we'll take a second look with a human, not a machine.`,
    },
};

/** {{var}} substitution. Unknown variables render as empty string.
 *  `escapeValues` HTML-escapes each value (for HTML template bodies, where a
 *  customer's name must not become markup). */
export function renderTemplate(tpl: string, vars: Record<string, string | number | undefined>, escapeValues = false): string {
    return String(tpl ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
        const v = vars[key];
        const s = v === undefined || v === null ? '' : String(v);
        return escapeValues ? escapeHtml(s) : s;
    });
}

/** Heading above the merchant's message, per outcome. */
export const MESSAGE_HEADINGS: Record<MessageKind, string> = {
    held: 'We are checking your order',
    approved: 'Your order is confirmed',
    rejected: 'About your order',
};

/**
 * The customer notice as sent: the merchant's subject and body (plain text or
 * HTML from the visual editor) inside the shared e-mail layout, with an order
 * reference box, the sign-off and a plain-text alternative. Variable values
 * are escaped in HTML bodies; plain-text bodies are escaped as a whole.
 */
export function buildCustomerMessage(
    kind: MessageKind,
    tpl: MessageTemplate,
    vars: Record<string, string | number | undefined>,
    brand: EmailBrand,
): { subject: string; html: string; text: string } {
    const subject = renderTemplate(tpl.subject || '', vars).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const isHtml = looksLikeHtml(tpl.body || '');
    const body: EmailBlock = isHtml
        ? { type: 'html', html: renderTemplate(tpl.body || '', vars, true) }
        : { type: 'paragraphs', text: renderTemplate(tpl.body || '', vars) };
    const blocks: EmailBlock[] = [];
    if (vars.orderCode) blocks.push({ type: 'info', rows: [{ label: 'Order', value: String(vars.orderCode), mono: true }] });
    blocks.push(body);
    const mail = renderEmail({ brand, heading: MESSAGE_HEADINGS[kind], preheader: subject, blocks });
    return { subject, ...mail };
}

/** Plain text -> simple paragraph HTML (blank-line separated). */
/** True when the body already contains block/inline HTML we should keep. */
export function looksLikeHtml(s: string): boolean {
    return /<\s*(p|div|a|h[1-6]|ul|ol|li|br|table|span|strong|em|b|i|img)\b/i.test(s || '');
}

/** Render a message body: pass HTML through untouched, wrap plain text into
 *  paragraphs. Lets the same field hold the plain-text defaults OR a styled
 *  HTML email built in the visual editor. */
export function renderBody(text: string): string {
    return looksLikeHtml(text) ? text : textToHtml(text);
}

export function textToHtml(text: string): string {
    const esc = (s: string) => s
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text
        .split(/\n\s*\n/)
        .map(p => `<p style="margin:0 0 14px;line-height:1.6">${esc(p.trim()).replace(/\n/g, '<br/>')}</p>`)
        .join('');
}
