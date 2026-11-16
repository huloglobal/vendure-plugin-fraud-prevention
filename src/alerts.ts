/**
 * Admin fraud-alert content (premium e-mail alerts). Each builder returns
 * structured content that `alertEmail` lays out in the shared, compact
 * e-mail design: heading, intro, info rows, signal list, optional button.
 * Nothing here is HTML, so customer-supplied values (order code, e-mail,
 * signal details) can never inject markup.
 */
import { EmailBlock, EmailBrand, renderEmail } from './email-layout';

export interface AlertSignal { label: string; points: number; detail?: string }

export interface AlertContent {
    heading: string;
    intro?: string;
    rows?: Array<{ label: string; value: string; mono?: boolean }>;
    signals?: AlertSignal[];
    /** Shown in an amber box (e.g. "protection is off"). */
    warning?: string;
    note?: string;
    button?: { url: string; label: string };
}

export function signalLine(s: AlertSignal): string {
    const pts = `${s.points >= 0 ? '+' : ''}${s.points}`;
    return `${s.label} (${pts})${s.detail ? `: ${s.detail}` : ''}`;
}

/** The alert as sent: compact layout, no customer sign-off. */
export function alertEmail(content: AlertContent, brand: EmailBrand): { html: string; text: string } {
    const blocks: EmailBlock[] = [];
    if (content.intro) blocks.push({ type: 'paragraphs', text: content.intro });
    if (content.rows?.length) blocks.push({ type: 'info', rows: content.rows });
    if (content.warning) blocks.push({ type: 'warning', text: content.warning });
    if (content.signals?.length) blocks.push({ type: 'list', title: 'Signals', items: content.signals.map(signalLine) });
    if (content.note) blocks.push({ type: 'paragraphs', text: content.note });
    if (content.button) blocks.push({ type: 'button', url: content.button.url, label: content.button.label });
    return renderEmail({
        brand: { ...brand, supportEmail: null },
        heading: content.heading,
        preheader: content.intro || content.heading,
        blocks,
        compact: true,
        signOff: false,
    });
}

interface OrderAlertInput {
    orderCode: string;
    orderId?: number | string | null;
    email: string;
    score: number;
    level: string;
    signals: AlertSignal[];
    baseUrl?: string;
}

function baseRows(i: OrderAlertInput, extra: Array<{ label: string; value: string; mono?: boolean }> = []) {
    return [
        { label: 'Order', value: i.orderCode || '-', mono: true },
        { label: 'Customer', value: i.email || '-' },
        { label: 'Risk score', value: `${i.score}/100 (${i.level})` },
        ...extra,
    ];
}

function trimBase(b?: string): string { return String(b || '').replace(/\/+$/, ''); }

/** Protection is off for the channel but the order scored as risky. */
export function shadowAlert(i: OrderAlertInput): AlertContent {
    return {
        heading: 'Risky order scored while protection is off',
        rows: baseRows(i),
        warning: 'No action was taken because fraud protection is switched off for this channel. Turn it on in Fraud Prevention → Settings to act on orders like this.',
        signals: i.signals,
    };
}

/** Monitor / hold mode: flagged, not in the review queue. */
export function flaggedAlert(i: OrderAlertInput & { mode: string }): AlertContent {
    const base = trimBase(i.baseUrl);
    return {
        heading: 'Risky order flagged',
        rows: baseRows(i),
        signals: i.signals,
        note: `It is not in the review queue (${i.mode} mode). Check it before you fulfil it.`,
        button: base && i.orderId ? { url: `${base}/admin/orders/${encodeURIComponent(String(i.orderId))}`, label: 'Open the order' } : undefined,
    };
}

/** Enforce mode: a review case was opened. */
export function heldAlert(i: OrderAlertInput & { block: boolean }): AlertContent {
    const base = trimBase(i.baseUrl);
    return {
        heading: i.block ? 'High-risk order held for review' : 'Order held for review',
        rows: baseRows(i),
        signals: i.signals,
        note: 'The order is in the review queue. Fulfil it only after you approve the case.',
        button: base ? { url: `${base}/admin/extensions/fraud-prevention`, label: 'Review the case' } : undefined,
    };
}

/** Hold / enforce mode: refused before the charge. */
export function refusedAlert(i: OrderAlertInput & { amount: string; reason: 'block-level' | 'failed-payment-cooldown' | string }): AlertContent {
    return {
        heading: 'Order refused before payment',
        rows: baseRows(i, [
            { label: 'Amount', value: i.amount },
            { label: 'Reason', value: i.reason === 'block-level' ? 'Block-level risk score' : 'Failed-payment cooldown' },
        ]),
        signals: i.signals,
        note: 'No payment was taken.',
    };
}
