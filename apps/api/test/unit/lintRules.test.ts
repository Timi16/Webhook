import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: new URL("../../../../", import.meta.url).pathname });

async function restricted(code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: "apps/api/src/lib/example.ts" });
  return result?.messages.filter((m) => m.ruleId === "no-restricted-syntax").length ?? 0;
}

describe("amount lint rules", () => {
  it("bans parseFloat everywhere", async () => {
    expect(await restricted(`export const a = parseFloat("1.5");`)).toBe(1);
    expect(await restricted(`export const a = Number.parseFloat("1.5");`)).toBe(1);
  });

  it("bans Number() on amount and stroops fields", async () => {
    expect(await restricted(`export const f = (amount: string) => Number(amount);`)).toBe(1);
    expect(
      await restricted(
        `export const f = (p: { amountStroops: bigint }) => Number(p.amountStroops);`,
      ),
    ).toBe(1);
    expect(
      await restricted(`export const f = (p: { minAmount: string }) => Number(p.minAmount);`),
    ).toBe(1);
  });

  it("allows Number() on non-amount values", async () => {
    expect(await restricted(`export const f = (port: string) => Number(port);`)).toBe(0);
  });
});
