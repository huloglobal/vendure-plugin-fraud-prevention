/**
 * Shared e-mail layout for every message the plugin sends: the customer
 * held / approved / rejected notices and the admin fraud alerts.
 *
 * A 600px white card on a light grey background, the merchant's logo (or
 * store name) over a 3px accent bar, then typed content blocks, the
 * sign-off and an optional footer strip. Inline styles and tables only (some
 * senders strip <style> blocks); every interpolated value is escaped except
 * an `html` block, which carries a merchant's own HTML template body.
 *
 * `renderEmail` returns both the HTML and a plain-text alternative.
 */

export const DEFAULT_ACCENT = '#155dfc';

export interface EmailBrand {
    /** Shown as bold text in the header when there is no logo, and in the sign-off. */
    storeName: string;
    /** `#rgb` / `#rrggbb`; anything else falls back to the default accent. */
    accentColor?: string | null;
    /** https only; ignored otherwise. */
    logoUrl?: string | null;
    /** Logo width in px (16–400, default 140). */
    logoWidth?: number | null;
    /** Merchant footer or legal text (plain text, new lines kept). */
    footerText?: string | null;
    /** Support address shown under the sign-off. */
    supportEmail?: string | null;
}

export type EmailBlock =
    /** Plain text: blank lines start paragraphs, single new lines become line breaks. */
    | { type: 'paragraphs'; text: string }
    /** Trusted HTML (a merchant's own template body). Not escaped. */
    | { type: 'html'; html: string }
    /** Grey info box with label/value rows. */
    | { type: 'info'; title?: string; rows: Array<{ label: string; value: string; mono?: boolean }> }
    /** Amber warning box. */
    | { type: 'warning'; title?: string; text: string }
    /** Bulleted list under an optional label. */
    | { type: 'list'; title?: string; items: string[] }
    /** Primary (accent background) or secondary (accent outline) button. */
    | { type: 'button'; url: string; label: string; secondary?: boolean };

export interface EmailInput {
    brand: EmailBrand;
    heading?: string;
    /** Hidden inbox preview text. */
    preheader?: string;
    blocks: EmailBlock[];
    /** Admin notifications: tighter padding and a smaller heading. */
    compact?: boolean;
    /** "Kind regards," + store name (+ support e-mail). Default true. */
    signOff?: boolean;
}

export function escapeHtml(v: unknown): string {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** A valid `#rgb` / `#rrggbb` colour, lower-cased, or the default accent. */
export function normaliseAccent(v: unknown): string {
    const s = String(v ?? '').trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : DEFAULT_ACCENT;
}

/** An absolute https URL, or '' (http/javascript/data and relative URLs are dropped). */
export function safeHttpsUrl(v: unknown): string {
    const s = String(v ?? '').trim();
    if (!s) return '';
    try {
        const u = new URL(s);
        return u.protocol === 'https:' ? u.toString() : '';
    } catch {
        return '';
    }
}

/** http(s) links for buttons; '' otherwise. */
export function safeLinkUrl(v: unknown): string {
    const s = String(v ?? '').trim();
    if (!s) return '';
    try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
    } catch {
        return '';
    }
}

function clampWidth(v: unknown): number {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 16 ? Math.min(n, 400) : 140;
}

const FONT = 'Arial, Helvetica, sans-serif';
const MONO = 'Consolas, Menlo, Monaco, monospace';
const LABEL = 'font-size:12px;line-height:16px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:bold;';
const BODY = `font-family:${FONT};font-size:14px;line-height:22px;color:#374151;`;

function paragraphsHtml(text: string): string {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `<p style="margin:0 0 14px 0;${BODY}">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

function blockHtml(b: EmailBlock, accent: string): string {
    switch (b.type) {
        case 'paragraphs':
            return paragraphsHtml(b.text);
        case 'html':
            return `<div style="${BODY}">${b.html}</div>`;
        case 'info': {
            const rows = b.rows.map(r =>
                `<tr><td style="padding:3px 12px 3px 0;font-family:${FONT};font-size:13px;line-height:20px;color:#6b7280;vertical-align:top;white-space:nowrap;">${escapeHtml(r.label)}</td>` +
                `<td style="padding:3px 0;font-family:${r.mono ? MONO : FONT};font-size:14px;line-height:20px;color:#111827;font-weight:bold;vertical-align:top;word-break:break-word;">${escapeHtml(r.value)}</td></tr>`,
            ).join('');
            return box('#f9fafb', '#e5e7eb',
                (b.title ? `<div style="${LABEL}padding-bottom:6px;">${escapeHtml(b.title)}</div>` : '') +
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>`);
        }
        case 'warning':
            return box('#fffbeb', '#fde68a',
                (b.title ? `<div style="font-family:${FONT};font-size:15px;line-height:20px;font-weight:bold;color:#92400e;padding-bottom:6px;">${escapeHtml(b.title)}</div>` : '') +
                `<div style="font-family:${FONT};font-size:13px;line-height:20px;color:#78350f;">${escapeHtml(b.text).replace(/\n/g, '<br>')}</div>`);
        case 'list': {
            if (!b.items.length) return '';
            const items = b.items.map(i => `<li style="margin:0 0 4px 0;">${escapeHtml(i)}</li>`).join('');
            return (b.title ? `<div style="${LABEL}padding:0 0 6px 0;">${escapeHtml(b.title)}</div>` : '') +
                `<ul style="margin:0 0 14px 0;padding:0 0 0 20px;${BODY}">${items}</ul>`;
        }
        case 'button': {
            const url = safeLinkUrl(b.url);
            if (!url) return '';
            const style = b.secondary
                ? `background-color:#ffffff;border:2px solid ${accent};color:${accent};`
                : `background-color:${accent};border:2px solid ${accent};color:#ffffff;`;
            return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 16px 0;"><tr>` +
                `<td style="border-radius:8px;background-color:${b.secondary ? '#ffffff' : accent};">` +
                `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:bold;text-decoration:none;border-radius:8px;${style}">${escapeHtml(b.label)}</a>` +
                `</td></tr></table>`;
        }
    }
}

function box(bg: string, border: string, inner: string): string {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 16px 0;">` +
        `<tr><td style="padding:14px 16px;background-color:${bg};border:1px solid ${border};border-radius:8px;">${inner}</td></tr></table>`;
}

/** Plain-text rendering of a block. */
function blockText(b: EmailBlock): string {
    switch (b.type) {
        case 'paragraphs':
            return String(b.text ?? '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).join('\n\n');
        case 'html':
            return htmlToText(b.html);
        case 'info':
            return [b.title ? b.title.toUpperCase() : '', ...b.rows.map(r => `${r.label}: ${r.value}`)].filter(Boolean).join('\n');
        case 'warning':
            return [b.title || '', b.text].filter(Boolean).join('\n');
        case 'list':
            return b.items.length ? [b.title ? b.title.toUpperCase() : '', ...b.items.map(i => `- ${i}`)].filter(Boolean).join('\n') : '';
        case 'button': {
            const url = safeLinkUrl(b.url);
            return url ? `${b.label}: ${url}` : '';
        }
    }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** Rough HTML → text for the plain-text alternative of an HTML template body. */
export function htmlToText(html: string): string {
    return String(html ?? '')
        .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
        .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
            const l = String(label).replace(/<[^>]+>/g, '').trim();
            return l && l !== href ? `${l} (${href})` : href;
        })
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol)>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_m, e) => ENTITIES[e] ?? _m)
        .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function renderEmail(input: EmailInput): { html: string; text: string } {
    const brand = input.brand;
    const accent = normaliseAccent(brand.accentColor);
    const logo = safeHttpsUrl(brand.logoUrl);
    const name = String(brand.storeName || '').trim();
    const pad = input.compact ? 20 : 28;
    const headingSize = input.compact ? 18 : 22;
    const signOff = input.signOff !== false;
    const support = String(brand.supportEmail || '').trim();
    const footer = String(brand.footerText || '').trim();

    const header = logo
        ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(name)}" width="${clampWidth(brand.logoWidth)}" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:100%;">`
        : `<span style="font-family:${FONT};font-size:18px;line-height:24px;font-weight:bold;color:#111827;">${escapeHtml(name)}</span>`;

    const heading = input.heading
        ? `<h1 style="margin:0 0 12px 0;font-family:${FONT};font-size:${headingSize}px;line-height:${headingSize + 6}px;font-weight:bold;color:#111827;">${escapeHtml(input.heading)}</h1>`
        : '';

    const blocks = input.blocks.map(b => blockHtml(b, accent)).join('');

    const sign = signOff
        ? `<p style="margin:8px 0 0 0;${BODY}">Kind regards,<br><strong style="color:#111827;">${escapeHtml(name)}</strong>` +
          (support ? `<br><a href="mailto:${escapeHtml(support)}" style="color:${accent};text-decoration:none;">${escapeHtml(support)}</a>` : '') + `</p>`
        : '';

    const foot = footer
        ? `<tr><td style="padding:14px ${pad}px;background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 10px 10px;font-family:${FONT};font-size:11px;line-height:17px;color:#6b7280;">${escapeHtml(footer).replace(/\n/g, '<br>')}</td></tr>`
        : '';

    const pre = input.preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f3f4f6;">${escapeHtml(input.preheader)}</div>`
        : '';

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.heading || name)}</title></head>` +
        `<body style="margin:0;padding:0;background-color:#f3f4f6;">${pre}` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">` +
        `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;">` +
        `<tr><td style="padding:${input.compact ? 16 : 22}px ${pad}px;border-bottom:3px solid ${accent};">${header}</td></tr>` +
        `<tr><td style="padding:${pad}px ${pad}px ${input.compact ? 16 : 24}px ${pad}px;">${heading}${blocks}${sign}</td></tr>` +
        foot +
        `</table></td></tr></table></body></html>`;

    const textParts: string[] = [];
    if (input.heading) textParts.push(input.heading);
    for (const b of input.blocks) {
        const t = blockText(b);
        if (t) textParts.push(t);
    }
    if (signOff) textParts.push(['Kind regards,', name, support].filter(Boolean).join('\n'));
    if (footer) textParts.push(`--\n${footer}`);
    const text = textParts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

    return { html, text };
}
