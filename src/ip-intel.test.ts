import { describe, it, expect, beforeEach } from 'vitest';
import { ipApiUrl, lookupIpIntel, _resetIpIntelState } from './ip-intel';

describe('lookupIpIntel (opt-in ip-api.com Pro)', () => {
    beforeEach(() => _resetIpIntelState());

    const ok = (body: object) => {
        const calls: string[] = [];
        const get = async (url: string) => { calls.push(url); return JSON.stringify(body); };
        return { calls, get };
    };

    it('makes no call at all without a key (off by default)', async () => {
        const m = ok({ status: 'success', countryCode: 'GB', proxy: true });
        const r = await lookupIpIntel('8.8.8.8', { get: m.get });
        expect(r.resolved).toBe(false);
        expect(m.calls).toHaveLength(0);
    });

    it('rejects non-addresses without a network call', async () => {
        const m = ok({ status: 'success' });
        const r = await lookupIpIntel('not-an-ip', { apiKey: 'k', get: m.get });
        expect(r.resolved).toBe(false);
        expect(m.calls).toHaveLength(0);
    });

    it('never looks up private, loopback, CGNAT, documentation or link-local addresses', async () => {
        const m = ok({ status: 'success', countryCode: 'GB' });
        for (const ip of ['10.1.2.3', '192.168.0.9', '172.20.1.1', '127.0.0.1', '100.64.1.1', '203.0.113.7', '169.254.1.1', '::1', 'fe80::1', 'fd00::5', '2001:db8::1']) {
            const r = await lookupIpIntel(ip, { apiKey: 'k', get: m.get });
            expect(r.resolved).toBe(false);
        }
        expect(m.calls).toHaveLength(0);
    });

    it('calls HTTPS pro.ip-api.com with the key and maps the answer', async () => {
        const m = ok({ status: 'success', countryCode: 'NL', proxy: true, hosting: false });
        const r = await lookupIpIntel('8.8.4.4', { apiKey: 'secret-key', get: m.get });
        expect(m.calls).toEqual([ipApiUrl('8.8.4.4', 'secret-key')]);
        expect(m.calls[0].startsWith('https://pro.ip-api.com/json/8.8.4.4?')).toBe(true);
        expect(m.calls[0]).toContain('key=secret-key');
        expect(r).toEqual({ ip: '8.8.4.4', countryCode: 'NL', isVpnOrProxy: true, isHosting: false, resolved: true });
    });

    it('accepts public IPv6', async () => {
        const m = ok({ status: 'success', countryCode: 'US', hosting: true });
        const r = await lookupIpIntel('2a06:98c0:3600::103', { apiKey: 'k', get: m.get });
        expect(r.resolved).toBe(true);
        expect(r.isHosting).toBe(true);
    });

    it('fails open and remembers a failed lookup so the next call returns at once', async () => {
        let n = 0;
        const get = async () => { n++; throw new Error('timeout'); };
        const a = await lookupIpIntel('9.9.9.9', { apiKey: 'k', get });
        const b = await lookupIpIntel('9.9.9.9', { apiKey: 'k', get });
        expect(a.resolved).toBe(false);
        expect(b.resolved).toBe(false);
        expect(n).toBe(1);
    });

    it('a non-success answer is a miss', async () => {
        const m = ok({ status: 'fail', message: 'invalid key' });
        const r = await lookupIpIntel('1.1.1.1', { apiKey: 'bad', get: m.get });
        expect(r.resolved).toBe(false);
    });
});
