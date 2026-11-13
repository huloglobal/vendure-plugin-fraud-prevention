import { describe, expect, it } from 'vitest';
import { convertLimit, formatMinor, limitScale, normaliseCurrency } from './money';

describe('currency-aware limits', () => {
    it('formats an amount in its own currency, never a hard-coded pound sign', () => {
        expect(formatMinor(123456, 'GBP')).toBe('£1,234.56');
        expect(formatMinor(123456, 'EUR')).toBe('€1,234.56');
        expect(formatMinor(123456, 'USD')).toBe('US$1,234.56');
        expect(formatMinor(120000, 'JPY')).toBe('JP¥1,200');
        expect(formatMinor(5000, null)).toBe('50.00');
        expect(formatMinor(5000, 'XXQ')).toMatch(/50\.00/);
    });

    it('scales defaults by the rough per-currency factor', () => {
        expect(limitScale('GBP')).toBe(1);
        expect(limitScale('usd')).toBe(1);
        expect(limitScale('JPY')).toBe(200);
        expect(limitScale('HUF')).toBe(500);
        expect(limitScale(undefined)).toBe(1);
    });

    it('converts a limit set in one currency to another, and leaves equal or unknown pairs alone', () => {
        expect(convertLimit(500_000, 'GBP', 'JPY')).toBe(100_000_000);
        expect(convertLimit(100_000_000, 'JPY', 'GBP')).toBe(500_000);
        expect(convertLimit(500_000, 'GBP', 'GBP')).toBe(500_000);
        expect(convertLimit(500_000, undefined, 'JPY')).toBe(500_000);
        expect(convertLimit(500_000, 'GBP', 'EUR')).toBe(500_000);
    });

    it('normalises currency codes', () => {
        expect(normaliseCurrency(' eur ')).toBe('EUR');
        expect(normaliseCurrency('euro')).toBeNull();
    });
});
