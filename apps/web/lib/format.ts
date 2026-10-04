/** GBJPABCD...CH5P -> GBJP…CH5P */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** https://api.shopkit.ng/hooks/stellar -> api.shopkit.ng/hooks/stellar */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Splits "19.5000000" into the part that carries value ("19.5") and its trailing zeros
 * ("000000"), which the design prints muted. Amounts stay strings: never parsed as floats.
 */
export function splitAmount(amount: string): { value: string; zeros: string } {
  const match = /^(\d+\.\d*?[1-9]|\d+\.)(0*)$/.exec(amount);
  return match
    ? { value: match[1] ?? amount, zeros: match[2] ?? "" }
    : { value: amount, zeros: "" };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 14:02:11 in the viewer's time zone. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 3 Oct 2026, 14:02:11 */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-GB", { month: "short" });
  return `${d.getDate()} ${month} ${d.getFullYear()}, ${clockTime(iso)}`;
}

/** "3 min ago", "in 6 min", "just now". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 10) return "just now";
  const [value, unit] =
    abs < 60
      ? [abs, "s"]
      : abs < 3600
        ? [Math.round(abs / 60), " min"]
        : abs < 86_400
          ? [Math.round(abs / 3600), " h"]
          : [Math.round(abs / 86_400), " d"];
  return seconds < 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
}

/** 412 -> "412 ms", 1900 -> "1.9 s" */
export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Whole-number percentage with one decimal, or a dash when there is nothing to divide by. */
export function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
}
