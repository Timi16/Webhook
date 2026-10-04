/** "::ffff:203.0.113.7" (IPv4 seen through an IPv6 socket) -> "203.0.113.7". */
export function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = parseInt(part, 10);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * Whether `ip` matches one of the rules (IPv4 addresses or CIDR ranges). An empty list allows
 * everything; with rules in place, an address that is not IPv4 never matches.
 */
export function ipAllowed(ip: string | null, rules: string[]): boolean {
  if (rules.length === 0) return true;
  const address = ip === null ? null : ipv4ToInt(ip);
  if (address === null) return false;
  return rules.some((rule) => {
    const [base, prefix] = rule.split("/");
    const network = ipv4ToInt(base ?? "");
    if (network === null) return false;
    const bits = prefix === undefined ? 32 : parseInt(prefix, 10);
    if (bits === 0) return true;
    const size = 2 ** (32 - bits);
    return Math.floor(address / size) === Math.floor(network / size);
  });
}
