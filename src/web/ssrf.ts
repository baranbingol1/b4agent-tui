/**
 * SSRF guard for web_fetch (plan section 18, hardening point 1).
 *
 * The address check runs inside the socket's `lookup`, so the address that is
 * checked is the address that is connected to: DNS rebinding between a
 * preflight check and the connection can't happen (Gemini CLI's `safeLookup`).
 * pi-web-access (MIT) validates in a preflight instead; its IPv6 parsing and
 * range list were the starting point here, extended with NAT64, 6to4,
 * Teredo, the IETF and documentation ranges.
 *
 * The client never uses a proxy (b4agent creates its own agents), so a proxy
 * can't resolve a name to an internal address on our behalf.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import net from "node:net";

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export interface GuardOptions {
  resolver?: Resolver;
  /**
   * Test hook: lets loopback addresses (127.0.0.0/8, ::1, `localhost`) through,
   * for tests and the e2e script against a local server. Every other private
   * range stays blocked.
   */
  allowLoopback?: boolean;
}

export class BlockedAddressError extends Error {
  constructor(
    readonly hostname: string,
    readonly address: string,
    readonly range: string,
  ) {
    super(`Blocked: ${hostname === address ? address : `${hostname} resolves to ${address}`}, which is ${range}. web_fetch only reaches public internet addresses.`);
    this.name = "BlockedAddressError";
  }
}

type V4Range = [base: number, bits: number, name: string];

const v4 = (s: string): number => s.split(".").reduce((acc, p) => acc * 256 + Number(p), 0);

const V4_BLOCKED: V4Range[] = [
  [v4("0.0.0.0"), 8, "a 'this network' address (0.0.0.0/8)"],
  [v4("10.0.0.0"), 8, "a private address (10.0.0.0/8)"],
  [v4("100.64.0.0"), 10, "a carrier-grade NAT address (100.64.0.0/10)"],
  [v4("127.0.0.0"), 8, "a loopback address (127.0.0.0/8)"],
  [v4("169.254.0.0"), 16, "a link-local or cloud metadata address (169.254.0.0/16)"],
  [v4("172.16.0.0"), 12, "a private address (172.16.0.0/12)"],
  [v4("192.0.0.0"), 24, "an IETF protocol address (192.0.0.0/24)"],
  [v4("192.0.2.0"), 24, "a documentation address (192.0.2.0/24)"],
  [v4("192.88.99.0"), 24, "a 6to4 relay address (192.88.99.0/24)"],
  [v4("192.168.0.0"), 16, "a private address (192.168.0.0/16)"],
  [v4("198.18.0.0"), 15, "a benchmarking or fake-IP proxy address (198.18.0.0/15)"],
  [v4("198.51.100.0"), 24, "a documentation address (198.51.100.0/24)"],
  [v4("203.0.113.0"), 24, "a documentation address (203.0.113.0/24)"],
  [v4("224.0.0.0"), 4, "a multicast address (224.0.0.0/4)"],
  [v4("240.0.0.0"), 4, "a reserved or broadcast address (240.0.0.0/4)"],
];

function v4Blocked(address: string): string | undefined {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return "not a valid IPv4 address";
  const n = v4(address);
  for (const [base, bits, name] of V4_BLOCKED) {
    const size = 2 ** (32 - bits);
    if (n >= base && n < base + size) return name;
  }
  return undefined;
}

/** Eight 16-bit groups, or null. Accepts embedded dotted IPv4 and zone ids. */
export function parseIPv6(input: string): number[] | null {
  let address = input.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (address.includes(".")) {
    const at = address.lastIndexOf(":");
    const tail = address.slice(at + 1);
    if (net.isIPv4(tail) === false) return null;
    const o = tail.split(".").map(Number) as [number, number, number, number];
    address = `${address.slice(0, at)}:${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : -1));
  return groups.length === 8 && groups.every((g) => g >= 0) ? groups : null;
}

const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function v6Blocked(address: string): string | undefined {
  const g = parseIPv6(address);
  if (!g) return "not a valid IPv6 address";
  const [a, b, c, d, e, f, gg, h] = g as [number, number, number, number, number, number, number, number];
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return "the unspecified address (::)";
  if (zeroTo(7) && h === 1) return "a loopback address (::1)";
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form (::a.b.c.d) reach the IPv4 host.
  if (zeroTo(5) && f === 0xffff) {
    const r = v4Blocked(embeddedV4(gg, h));
    return r && `an IPv4-mapped IPv6 address of ${r}`;
  }
  if (zeroTo(6)) {
    const r = v4Blocked(embeddedV4(gg, h));
    return r && `an IPv4-compatible IPv6 address of ${r}`;
  }
  // NAT64: the well-known prefix carries the IPv4 target; the local-use prefix is internal by definition.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    const r = v4Blocked(embeddedV4(gg, h));
    return r && `a NAT64 address of ${r}`;
  }
  if (a === 0x64 && b === 0xff9b && c === 1) return "a local-use NAT64 address (64:ff9b:1::/48)";
  if (a === 0x2002) {
    const r = v4Blocked(embeddedV4(b, c));
    return r && `a 6to4 address of ${r}`;
  }
  if (a === 0x2001 && b === 0) return "a Teredo address (2001::/32)";
  if (a === 0x2001 && b === 0xdb8) return "a documentation address (2001:db8::/32)";
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return "a discard address (100::/64)";
  if ((a & 0xfe00) === 0xfc00) return "a unique local address (fc00::/7), which includes cloud metadata endpoints";
  if ((a & 0xffc0) === 0xfe80) return "a link-local address (fe80::/10)";
  if ((a & 0xffc0) === 0xfec0) return "a site-local address (fec0::/10)";
  if ((a & 0xff00) === 0xff00) return "a multicast address (ff00::/8)";
  return undefined;
}

const LOOPBACK = (address: string) => {
  if (net.isIPv4(address)) return address.startsWith("127.");
  const g = parseIPv6(address);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && g[6]! >> 8 === 127;
};

/** Why an address must not be fetched, or undefined when it is public. */
export function blockedRange(address: string, opts: GuardOptions = {}): string | undefined {
  const a = address.replace(/^\[|\]$/g, "");
  if (opts.allowLoopback && LOOPBACK(a)) return undefined;
  const family = net.isIP(a.replace(/%.*$/, ""));
  if (family === 4) return v4Blocked(a);
  if (family === 6) return v6Blocked(a);
  return "not an IP address";
}

/** Throws for a hostname that is itself internal (`localhost`, an internal IP literal). */
export function checkHostname(hostname: string, opts: GuardOptions = {}): void {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new Error("The URL has no host.");
  if (host === "localhost" || host.endsWith(".localhost")) {
    if (opts.allowLoopback && host === "localhost") return;
    throw new BlockedAddressError(host, host, "a loopback name");
  }
  if (net.isIP(host)) {
    const r = blockedRange(host, opts);
    if (r) throw new BlockedAddressError(host, host, r);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for `http.request` / `net.connect`: resolves with the injected
 * resolver and fails if any address is internal (a name with one public and
 * one private address could be connected to either).
 */
export function guardedLookup(opts: GuardOptions = {}) {
  const resolve = opts.resolver ?? systemResolver;
  return (hostname: string, options: { all?: boolean; family?: number | string } | number, callback: LookupCallback): void => {
    const all = typeof options === "object" && options.all === true;
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length) return callback(Object.assign(new Error(`${hostname} did not resolve to any address`), { code: "ENOTFOUND" }), "");
        for (const { address } of addresses) {
          const r = blockedRange(address, opts);
          if (r) return callback(new BlockedAddressError(hostname, address, r), "");
        }
        if (all) return callback(null, addresses);
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}
