// Dependency-free Stellar StrKey checks so the API and the dashboard validate addresses identically.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const VERSION_PUBLIC_KEY = 6 << 3; // G
const VERSION_SECRET_SEED = 18 << 3; // S
const VERSION_CONTRACT = 2 << 3; // C

function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return bits === 0 ? Uint8Array.from(out) : null;
}

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function isValidKey(input: unknown, version: number): boolean {
  if (typeof input !== "string" || input.length !== 56) return false;
  const bytes = base32Decode(input);
  if (!bytes || bytes.length !== 35 || bytes[0] !== version) return false;
  const expected = crc16Xmodem(bytes.subarray(0, 33));
  return bytes[33] === (expected & 0xff) && bytes[34] === expected >>> 8;
}

export function isValidPublicKey(input: unknown): boolean {
  return isValidKey(input, VERSION_PUBLIC_KEY);
}

export function isValidSecretSeed(input: unknown): boolean {
  return isValidKey(input, VERSION_SECRET_SEED);
}

export function isValidContractAddress(input: unknown): boolean {
  return isValidKey(input, VERSION_CONTRACT);
}
