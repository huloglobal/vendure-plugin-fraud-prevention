/**
 * Small pure helpers: CIDR matching for IPv4 and IPv6 blocklist ranges
 * (Spamhaus DROP ships ranges, and the previous implementation never
 * matched them at all) and email normalisation for plus-addressing / dot-trick
 * detection.
 */

/** Canonical client address: IPv4-mapped IPv6 (`::ffff:1.2.3.4`, what dual-stack sockets report) becomes plain IPv4; everything is lowercased and trimmed. */
export function normaliseIp(raw: unknown): string {
    const s = String(raw ?? '').trim().toLowerCase();
    const m = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    return m ? m[1] : s;
}

export function ipv4ToInt(ip: string): number | null {
    const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some(p => p > 255)) return null;
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Expand an IPv6 address (with `::` compression, an optional `%zone` and
 * the IPv4-mapped / dotted-quad tail `::ffff:1.2.3.4`) to its 128-bit
 * value. Returns null for anything that is not a well-formed address.
 */
export function ipv6ToBigInt(ip: string): bigint | null {
    let s = ip.trim().toLowerCase();
    if (!s || s.includes('/')) return null;
    const zone = s.indexOf('%');
    if (zone >= 0) s = s.slice(0, zone);
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null;
    // Dotted-quad tail (::ffff:1.2.3.4, ::1.2.3.4) → two 16-bit groups.
    const lastColon = s.lastIndexOf(':');
    if (s.includes('.')) {
        const v4 = ipv4ToInt(s.slice(lastColon + 1));
        if (v4 == null) return null;
        s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const parse = (part: string): number[] | null => {
        if (part === '') return [];
        const groups = part.split(':');
        const out: number[] = [];
        for (const g of groups) {
            if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
            out.push(parseInt(g, 16));
        }
        return out;
    };
    const head = parse(halves[0]);
    const tail = halves.length === 2 ? parse(halves[1]) : [];
    if (!head || !tail) return null;
    let groups: number[];
    if (halves.length === 2) {
        const fill = 8 - head.length - tail.length;
        if (fill < 1) return null; // "::" must stand for at least one group
        groups = [...head, ...new Array(fill).fill(0), ...tail];
    } else {
        if (head.length !== 8) return null;
        groups = head;
    }
    let n = BigInt(0);
    for (const g of groups) n = (n << BigInt(16)) | BigInt(g);
    return n;
}

const V6_ALL_ONES = (BigInt(1) << BigInt(128)) - BigInt(1);

export type ParsedCidr = { family: 4; base: number; bits: number } | { family: 6; base: bigint; bits: number };

/** Parse "a.b.c.d/n", "x::y/n" or a bare address (= /32 or /128). Null when malformed. */
export function parseCidr(cidr: string): ParsedCidr | null {
    const parts = String(cidr ?? '').trim().split('/');
    if (parts.length > 2 || !parts[0]) return null;
    const [base, bitsRaw] = parts;
    if (bitsRaw !== undefined && !/^\d{1,3}$/.test(bitsRaw)) return null;
    const v4 = ipv4ToInt(base);
    if (v4 != null) {
        const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
        return bits <= 32 ? { family: 4, base: v4, bits } : null;
    }
    const v6 = ipv6ToBigInt(base);
    if (v6 == null) return null;
    const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
    return bits <= 128 ? { family: 6, base: v6, bits } : null;
}

/** True for a well-formed IPv4 or IPv6 range (or bare address). */
export function isCidr(value: string): boolean {
    return parseCidr(value) != null;
}

/**
 * True when `ip` falls inside `cidr` — IPv4 ("1.2.3.0/24" or a bare IP)
 * or IPv6 ("2001:db8::/32", "::ffff:1.2.3.0/120", a bare IP = /128).
 * An IPv4 address is also matched against IPv4-mapped IPv6 ranges and an
 * IPv4-mapped address (`::ffff:1.2.3.4`) against IPv4 ranges, so a list
 * entry matches however the socket happened to report the client.
 * Malformed input never throws; it simply does not match.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
    const range = parseCidr(cidr);
    if (!range) return false;
    const client = normaliseIp(ip);
    const ipInt = ipv4ToInt(client);
    if (range.family === 4) {
        // IPv4 fast path (32-bit integer arithmetic).
        if (ipInt == null) return false;
        if (range.bits === 0) return true;
        const mask = range.bits === 32 ? 0xffffffff : (~((1 << (32 - range.bits)) - 1)) >>> 0;
        return ((ipInt & mask) >>> 0) === ((range.base & mask) >>> 0);
    }
    // IPv6 (BigInt over the expanded 128-bit form); an IPv4 client is compared as ::ffff:a.b.c.d.
    const ipBig = ipInt != null ? (BigInt(0xffff) << BigInt(32)) | BigInt(ipInt) : ipv6ToBigInt(client);
    if (ipBig == null) return false;
    if (range.bits === 0) return true;
    const mask = (V6_ALL_ONES << BigInt(128 - range.bits)) & V6_ALL_ONES;
    return (ipBig & mask) === (range.base & mask);
}

/** A syntactically valid IPv4 / IPv6 address after `normaliseIp` (brackets and an IPv4 `:port` stripped), or ''. */
function cleanIp(raw: unknown): string {
    let s = normaliseIp(raw);
    if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
    s = normaliseIp(s);
    return ipv4ToInt(s) != null || ipv6ToBigInt(s) != null ? s : '';
}

export interface ClientIpRequest {
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
    socket?: { remoteAddress?: string } | null;
}

export interface ClientIpOptions {
    /** Proxies (addresses or CIDRs) whose forwarding headers are believed. */
    trustedProxies?: string[];
    /** Read `cf-connecting-ip` from a trusted proxy. Default true when `trustedProxies` is set. */
    trustCloudflareHeader?: boolean;
}

function header(req: ClientIpRequest, name: string): string {
    const v = req.headers?.[name];
    return String(Array.isArray(v) ? v[0] ?? '' : v ?? '').trim();
}

/** True when the request's socket peer is one of `trustedProxies`. */
export function fromTrustedProxy(req: ClientIpRequest, opts: ClientIpOptions = {}): boolean {
    const proxies = opts.trustedProxies || [];
    const peer = cleanIp(req.socket?.remoteAddress);
    return !!peer && proxies.some(p => ipInCidr(peer, p));
}

/**
 * The caller's address, never one it chooses. Forwarding headers are read
 * only when the socket peer is a configured trusted proxy: then
 * `cf-connecting-ip` (unless turned off), else the right-most
 * `x-forwarded-for` hop that is not itself a trusted proxy. With trusted
 * proxies configured, any other peer's socket address is used as is.
 * Without them the address is `req.ip` — Express applies the host's own
 * `trust proxy` setting there — or the socket address.
 */
export function clientIpFromRequest(req: ClientIpRequest, opts: ClientIpOptions = {}): string {
    const proxies = opts.trustedProxies || [];
    if (proxies.length && fromTrustedProxy(req, opts)) {
        if (opts.trustCloudflareHeader !== false) {
            const cf = cleanIp(header(req, 'cf-connecting-ip'));
            if (cf) return cf;
        }
        const hops = header(req, 'x-forwarded-for').split(',').map(s => s.trim()).filter(Boolean);
        for (let i = hops.length - 1; i >= 0; i--) {
            const hop = cleanIp(hops[i]);
            if (!hop) break; // malformed: everything to its left came from the client
            if (!proxies.some(p => ipInCidr(hop, p))) return hop;
        }
        return cleanIp(req.socket?.remoteAddress);
    }
    // With trusted proxies configured, an untrusted peer is the client itself.
    if (proxies.length) return cleanIp(req.socket?.remoteAddress) || cleanIp(req.ip);
    return cleanIp(req.ip) || cleanIp(req.socket?.remoteAddress);
}

export interface NormalizedEmail {
    /** Lowercased original. */
    email: string;
    domain: string;
    /** Canonical form: gmail dots stripped, +tag removed — the identity a
     *  fraudster can't multiply by re-tagging one inbox. */
    canonical: string;
    usedPlusAddressing: boolean;
}

const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function normalizeEmail(raw: string): NormalizedEmail | null {
    const email = (raw || '').trim().toLowerCase();
    const at = email.lastIndexOf('@');
    if (at <= 0 || at === email.length - 1) return null;
    let local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const usedPlusAddressing = local.includes('+');
    if (usedPlusAddressing) local = local.split('+')[0];
    if (DOT_INSENSITIVE_DOMAINS.has(domain)) local = local.replace(/\./g, '');
    return { email, domain, canonical: `${local}@${domain}`, usedPlusAddressing };
}

/** Ranges that never identify a customer on the public internet: private,
 *  loopback, link-local, carrier-grade NAT, documentation, benchmarking,
 *  multicast and reserved space (IPv4 and IPv6). */
const NON_PUBLIC_RANGES = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
    '224.0.0.0/4', '240.0.0.0/4',
    '::/127', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8',
];

/** A syntactically valid address that is routable on the public internet. */
export function isPublicIp(raw: unknown): boolean {
    const ip = cleanIp(raw);
    if (!ip) return false;
    return !NON_PUBLIC_RANGES.some(r => ipInCidr(ip, r));
}

/**
 * Forwarding headers a request carried that were NOT believed: the peer is
 * not a configured trusted proxy (or none are configured and Express did not
 * apply them either), yet it named a different public client. Behind such a
 * peer every customer is scored with the proxy's own address, so velocity
 * and list signals lump all of them together. Returns null when nothing was
 * ignored.
 */
export function ignoredForwarding(req: ClientIpRequest, opts: ClientIpOptions = {}): { peer: string; header: string; client: string } | null {
    const peer = cleanIp(req.socket?.remoteAddress);
    if (!peer) return null;
    const resolved = clientIpFromRequest(req, opts);
    if (resolved && resolved !== peer) return null; // the headers were applied (trusted proxy or Express trust proxy)
    for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) {
        const raw = header(req, name);
        if (!raw) continue;
        const hops = raw.split(',').map(s => s.trim()).filter(Boolean);
        const client = cleanIp(hops[hops.length - 1]);
        if (client && client !== peer && isPublicIp(client)) return { peer, header: name, client };
        return null;
    }
    return null;
}
