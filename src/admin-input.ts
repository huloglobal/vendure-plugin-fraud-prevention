/**
 * Validation and masking for admin REST input (kept out of the controller so
 * it can be unit-tested without Nest).
 */

/** Notification fields that are credentials (masked in GET, kept on save when the mask comes back). */
export const SECRET_NOTIF_FIELDS = ['slackWebhookUrl', 'discordWebhookUrl', 'teamsWebhookUrl', 'telegramBotToken', 'genericWebhookSecret'] as const;
export const SECRET_MASK = '••••••••';

export function maskNotificationSecrets<T extends Record<string, any>>(cfg: T): T {
    const out: any = { ...cfg };
    for (const f of SECRET_NOTIF_FIELDS) out[f] = cfg[f] ? SECRET_MASK : '';
    return out;
}

/** A field sent back as the mask keeps its stored value; anything else replaces it. */
export function unmaskNotificationSecrets(body: Record<string, any>, current: Record<string, any>): Record<string, any> {
    const out: any = { ...body };
    for (const f of SECRET_NOTIF_FIELDS) {
        if (out[f] === SECRET_MASK || out[f] === undefined) out[f] = current[f] || '';
    }
    return out;
}

/** Null when the notification settings are acceptable, else a message. */
export function validateNotificationConfig(body: any): string | null {
    const email = String(body?.adminEmail ?? '').trim();
    if (email.length > 1000 || (email && !email.split(',').every(e => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e.trim())))) {
        return 'The alert e-mail address is not valid (separate several with commas).';
    }
    for (const f of ['slackWebhookUrl', 'discordWebhookUrl', 'teamsWebhookUrl', 'genericWebhookUrl']) {
        const v = String(body?.[f] ?? '').trim();
        if (v && v !== SECRET_MASK && (v.length > 2000 || !/^https:\/\//i.test(v))) return `${f} must be an https:// URL.`;
    }
    for (const f of ['telegramBotToken', 'telegramChatId', 'genericWebhookSecret']) {
        if (String(body?.[f] ?? '').length > 500) return `${f} is too long.`;
    }
    return null;
}

/** Null when a customer-message save/reset is acceptable, else a message
 *  (a missing channel used to reach SQL as NaN; an empty subject sent subject-less e-mails). */
export function validateTemplateSave(body: any): string | null {
    if (!body || !['held', 'approved', 'rejected'].includes(body.kind)) return 'Unknown message kind.';
    const channelId = Number(body.channelId);
    if (!Number.isInteger(channelId) || channelId <= 0) return 'A channel is required.';
    if (body.reset) return null;
    const subject = String(body.subject ?? '').trim();
    if (!subject) return 'The subject cannot be empty.';
    if (subject.length > 500) return 'The subject is too long (500 characters at most).';
    const text = String(body.body ?? '');
    if (!text.trim()) return 'The message cannot be empty.';
    if (text.length > 50_000) return 'The message is too long.';
    return null;
}

/** Row limit for list endpoints: 1-500, default 100 (a bad value used to reach SQL as LIMIT NaN). */
export function clampTake(v: unknown, def = 100): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : def;
}
