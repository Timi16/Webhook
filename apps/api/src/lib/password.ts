import argon2 from "argon2";

// A short list of the most common passwords of 10+ characters (shorter ones fail the length rule).
const COMMON_PASSWORDS = new Set([
  "1234567890",
  "12345678910",
  "123456789a",
  "1q2w3e4r5t",
  "qwertyuiop",
  "qwerty12345",
  "qwerty123456",
  "password12",
  "password123",
  "password1234",
  "passwordpassword",
  "iloveyou12",
  "iloveyou123",
  "1234512345",
  "0987654321",
  "1122334455",
  "abcdefghij",
  "abcd123456",
  "abc1234567",
  "a123456789",
  "q1w2e3r4t5",
  "1qaz2wsx3edc",
  "zaq12wsxcde3",
  "letmein123",
  "welcome123",
  "welcome1234",
  "admin12345",
  "administrator",
  "changeme123",
  "football123",
  "baseball123",
  "superman123",
  "sunshine123",
  "princess123",
  "starwars123",
  "trustno1234",
  "0123456789",
  "9876543210",
  "1111111111",
  "0000000000",
  "aaaaaaaaaa",
  "qazwsxedcrfv",
  "asdfghjkl123",
  "asdfghjkl;",
  "zxcvbnm123",
  "monkey12345",
  "dragon12345",
  "michael123",
  "webhook123",
  "stellar123",
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Burns the same time as a real verification, so unknown emails are indistinguishable. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
}
