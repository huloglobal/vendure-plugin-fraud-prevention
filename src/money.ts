/**
 * Money for the value limits and signal details. Vendure stores every amount
 * as an integer in hundredths of the currency's major unit (its default
 * MoneyStrategy, whatever decimals the currency displays), so limits and
 * order totals share that unit. Limits belong to the channel's default
 * currency; an order in another currency is compared against a limit
 * converted by the rough LIMIT_SCALE factors below (the same factors the
 * WordPress edition uses), never against the raw number.
 */

/**
 * Roughly how many units of a currency are worth one pound, euro or dollar,
 * rounded to 1, 2 or 5 times a power of ten. The default limits (sized in
 * pounds, euros or dollars) are multiplied by it, so a new channel in yen or
 * forint does not flag ordinary purchases. Only the order of magnitude
 * matters; merchants set their own limits on the Rules tab. Unlisted = 1.
 */
const LIMIT_SCALE: Record<number, string[]> = {
    2: ['AUD', 'AZN', 'BAM', 'BGN', 'CAD', 'NZD', 'SGD'],
    5: ['AED', 'BYN', 'GEL', 'ILS', 'LYD', 'MYR', 'PEN', 'PLN', 'QAR', 'RON', 'SAR', 'TND'],
    10: ['BOB', 'BRL', 'CNY', 'DKK', 'GTQ', 'HKD', 'MAD', 'NOK', 'SEK', 'TTD'],
    20: ['CZK', 'GHS', 'MDL', 'MXN', 'ZAR'],
    50: ['EGP', 'HNL', 'MUR', 'THB', 'TRY', 'TWD', 'UAH', 'UYU', 'ZMW'],
    100: ['ALL', 'DOP', 'INR', 'MKD', 'PHP', 'RSD', 'RUB', 'XPF'],
    200: ['BDT', 'DJF', 'DZD', 'ETB', 'ISK', 'JMD', 'JPY', 'KES', 'NPR', 'VUV'],
    500: ['AMD', 'CRC', 'HUF', 'KMF', 'KZT', 'LKR', 'PKR'],
    1000: ['CLP', 'XAF', 'XOF'],
    2000: ['ARS', 'IQD', 'KRW', 'MMK', 'NGN', 'RWF'],
    5000: ['BIF', 'COP', 'KHR', 'MGA', 'MNT', 'TZS', 'UGX'],
    10000: ['GNF', 'PYG'],
    20000: ['IDR', 'LAK', 'UZS'],
    50000: ['VND'],
};

/** A three-letter currency code, upper-cased, or null. */
export function normaliseCurrency(code: unknown): string | null {
    const c = String(code ?? '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : null;
}

/** The factor the default limits are multiplied by for this currency. */
export function limitScale(currency?: string | null): number {
    const c = normaliseCurrency(currency);
    if (!c) return 1;
    for (const [factor, codes] of Object.entries(LIMIT_SCALE)) {
        if (codes.includes(c)) return Number(factor);
    }
    return 1;
}

/** A value limit set in one currency, roughly in another (by the ratio of
 *  their LIMIT_SCALE factors). For limits only, never for payment amounts. */
export function convertLimit(minor: number, from?: string | null, to?: string | null): number {
    const f = normaliseCurrency(from);
    const t = normaliseCurrency(to);
    if (!f || !t || f === t) return minor;
    const v = Math.round(minor * limitScale(t) / limitScale(f));
    return Number.isFinite(v) ? Math.max(0, Math.min(v, Number.MAX_SAFE_INTEGER)) : minor;
}

/** "£12.50", "¥1,200", "CHF 99.00" — a Vendure amount in its currency.
 *  Without a currency the plain number with two decimals. */
export function formatMinor(minor: number, currency?: string | null): string {
    const major = Number(minor || 0) / 100;
    const c = normaliseCurrency(currency);
    if (!c) return major.toFixed(2);
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: c }).format(major);
    } catch {
        return `${major.toFixed(2)} ${c}`;
    }
}
