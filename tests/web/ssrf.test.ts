import { describe, expect, it } from "vitest";
import { blockedRange, checkHostname, guardedLookup, parseIPv6 } from "../../src/web/ssrf.js";

const blocked: [address: string, range: RegExp][] = [
  ["127.0.0.1", /loopback/],
  ["127.255.0.9", /loopback/],
  ["10.1.2.3", /private/],
  ["172.31.255.255", /private/],
  ["192.168.0.1", /private/],
  ["169.254.169.254", /metadata/],
  ["100.64.0.1", /carrier-grade/],
  ["100.127.255.255", /carrier-grade/],
  ["0.1.2.3", /this network/],
  ["198.18.0.1", /benchmarking/],
  ["198.19.255.254", /benchmarking/],
  ["224.0.0.1", /multicast/],
  ["255.255.255.255", /reserved/],
  ["::1", /loopback/],
  ["::", /unspecified/],
  // IPv4-mapped IPv6, dotted and hex forms (the URL parser produces the hex one).
  ["::ffff:127.0.0.1", /IPv4-mapped.*loopback/],
  ["::ffff:7f00:1", /IPv4-mapped.*loopback/],
  ["::ffff:a9fe:a9fe", /IPv4-mapped.*metadata/],
  ["::127.0.0.1", /IPv4-compatible/],
  // NAT64 with an internal IPv4 inside, and the local-use NAT64 prefix.
  ["64:ff9b::10.0.0.1", /NAT64.*private/],
  ["64:ff9b::7f00:1", /NAT64.*loopback/],
  ["64:ff9b:1::1", /local-use NAT64/],
  ["2002:7f00:1::1", /6to4.*loopback/],
  ["2001:0:4136:e378::1", /Teredo/],
  ["fd00:ec2::254", /unique local/],
  ["fc00::1", /unique local/],
  ["fe80::1%eth0", /link-local/],
  ["ff02::1", /multicast/],
];

const allowed = ["93.184.216.34", "1.1.1.1", "8.8.8.8", "100.128.0.1", "172.32.0.1", "2606:4700:4700::1111", "64:ff9b::808:808", "::ffff:8.8.8.8", "2002:808:808::1"];

describe("blockedRange", () => {
  for (const [a, re] of blocked) it(`blocks ${a}`, () => expect(blockedRange(a)).toMatch(re));
  for (const a of allowed) it(`allows ${a}`, () => expect(blockedRange(a)).toBeUndefined());

  it("lets only loopback through with the test hook", () => {
    expect(blockedRange("127.0.0.1", { allowLoopback: true })).toBeUndefined();
    expect(blockedRange("::1", { allowLoopback: true })).toBeUndefined();
    expect(blockedRange("::ffff:127.0.0.1", { allowLoopback: true })).toBeUndefined();
    expect(blockedRange("10.0.0.1", { allowLoopback: true })).toMatch(/private/);
    expect(blockedRange("169.254.169.254", { allowLoopback: true })).toMatch(/metadata/);
  });

  it("parses embedded IPv4 and rejects junk", () => {
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(blockedRange("not-an-ip")).toBe("not an IP address");
  });
});

describe("checkHostname", () => {
  it("refuses localhost names and internal literals before any connection", () => {
    expect(() => checkHostname("localhost")).toThrow(/loopback name/);
    expect(() => checkHostname("api.localhost")).toThrow(/loopback name/);
    expect(() => checkHostname("[::ffff:7f00:1]")).toThrow(/IPv4-mapped/);
    expect(() => checkHostname("169.254.169.254")).toThrow(/metadata/);
    expect(() => checkHostname("example.com")).not.toThrow();
  });
});

describe("guardedLookup", () => {
  const lookup = (map: Record<string, string[]>) =>
    guardedLookup({ resolver: async (h) => (map[h] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) });
  const run = (fn: ReturnType<typeof lookup>, host: string, all = true) =>
    new Promise<{ err: Error | null; addr: unknown }>((resolve) => fn(host, { all }, (err, addr) => resolve({ err, addr })));

  it("fails a name that resolves to 127.0.0.1", async () => {
    const r = await run(lookup({ "evil.test": ["127.0.0.1"] }), "evil.test");
    expect(r.err?.message).toMatch(/evil\.test resolves to 127\.0\.0\.1, which is a loopback address/);
  });
  it("fails when any one of several addresses is internal", async () => {
    const r = await run(lookup({ "mixed.test": ["93.184.216.34", "10.0.0.5"] }), "mixed.test");
    expect(r.err?.message).toMatch(/10\.0\.0\.5/);
  });
  it("passes public addresses through, in both callback shapes", async () => {
    const fn = lookup({ "ok.test": ["93.184.216.34", "2606:4700::1"] });
    expect((await run(fn, "ok.test")).addr).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1", family: 6 }]);
    expect((await run(fn, "ok.test", false)).addr).toBe("93.184.216.34");
  });
  it("reports names that don't resolve", async () => {
    expect((await run(lookup({}), "nx.test")).err?.message).toMatch(/did not resolve/);
  });
});
