import { isIpRule } from "@webhook/shared";
import { describe, expect, it } from "vitest";
import { ipAllowed, normalizeIp } from "../../src/lib/ip.js";

describe("API key IP rules", () => {
  it("accepts IPv4 addresses and CIDR ranges only", () => {
    for (const rule of ["203.0.113.7", "203.0.113.0/24", "0.0.0.0/0", "10.1.2.3/32"]) {
      expect(isIpRule(rule), rule).toBe(true);
    }
    for (const rule of ["256.1.1.1", "1.2.3", "1.2.3.4/33", "::1", "example.com", "1.2.3.4/", ""]) {
      expect(isIpRule(rule), rule).toBe(false);
    }
  });

  it("an empty list allows any address", () => {
    expect(ipAllowed("198.51.100.4", [])).toBe(true);
    expect(ipAllowed(null, [])).toBe(true);
    expect(ipAllowed("::1", [])).toBe(true);
  });

  it("matches exact addresses and ranges, including the edges of a range", () => {
    const rules = ["102.89.34.12", "41.58.112.0/24"];
    expect(ipAllowed("102.89.34.12", rules)).toBe(true);
    expect(ipAllowed("102.89.34.13", rules)).toBe(false);
    expect(ipAllowed("41.58.112.0", rules)).toBe(true);
    expect(ipAllowed("41.58.112.255", rules)).toBe(true);
    expect(ipAllowed("41.58.113.0", rules)).toBe(false);
    expect(ipAllowed("200.1.1.1", ["128.0.0.0/1"])).toBe(true); // above 2^31: no sign trouble
    expect(ipAllowed("9.9.9.9", ["0.0.0.0/0"])).toBe(true);
  });

  it("with rules in place, an unknown or IPv6 address never matches", () => {
    expect(ipAllowed(null, ["203.0.113.7"])).toBe(false);
    expect(ipAllowed("::1", ["0.0.0.0/0"])).toBe(false);
  });

  it("unwraps IPv4 addresses that arrive through an IPv6 socket", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("::1")).toBe("::1");
    expect(normalizeIp(undefined)).toBeNull();
  });
});
