import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { isValidContractAddress, isValidPublicKey, isValidSecretSeed } from "@webhook/shared";
import { describe, expect, it } from "vitest";

describe("shared StrKey checks agree with the Stellar SDK", () => {
  it("accepts real keys and tells public keys from secret seeds", () => {
    for (let i = 0; i < 25; i++) {
      const kp = Keypair.random();
      expect(isValidPublicKey(kp.publicKey())).toBe(true);
      expect(isValidSecretSeed(kp.secret())).toBe(true);
      expect(isValidPublicKey(kp.secret())).toBe(false);
      expect(isValidSecretSeed(kp.publicKey())).toBe(false);
    }
  });

  it("rejects corrupted checksums, wrong lengths and other key types", () => {
    const key = Keypair.random().publicKey();
    const corrupted = key.slice(0, 55) + (key.endsWith("A") ? "B" : "A");
    expect(StrKey.isValidEd25519PublicKey(corrupted)).toBe(false);
    expect(isValidPublicKey(corrupted)).toBe(false);
    expect(isValidPublicKey(key.slice(0, 55))).toBe(false);
    expect(isValidPublicKey(key.toLowerCase())).toBe(false);
    expect(isValidPublicKey("")).toBe(false);
    expect(isValidPublicKey(undefined)).toBe(false);
    const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    expect(isValidContractAddress(contract)).toBe(true);
    expect(isValidPublicKey(contract)).toBe(false);
  });
});
