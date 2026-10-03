// Testnet scenario and live demo: real payments, end to end, asserted through the API.
//
// Needs the API and the worker running with ALLOW_INSECURE_WEBHOOK_TARGETS=true (the webhook
// target is a local mock receiver started by this script).
//
//   pnpm --filter @webhook/scripts scenario
//
// Creates Friendbot accounts and trustlines, registers a watch, sends 20 payments covering
// every case (normal, wrong asset, fake-issuer USDC, wrong amount, memo cases, path payment,
// M-address, issuer mint) and checks: exactly 20 payments with the right outcomes, and one
// verified, signed webhook per payment.
import { Account, Asset, Keypair, Memo, MuxedAccount, Operation } from "@stellar/stellar-sdk";
import { developerClient, fundWithFriendbot, sleep, submit } from "./lib.js";
import { startMockReceiver, verifyWebhook } from "./mock-receiver.js";

const RECEIVER_PORT = parseInt(process.env.RECEIVER_PORT ?? "4100", 10);
const WAIT_MS = parseInt(process.env.SCENARIO_WAIT_MS ?? "180000", 10);
let receiverHealthyAt = 0;

interface Case {
  name: string;
  amount: string;
  asset: "usdc" | "fake" | "xlm";
  memo?: Memo;
  via?: "payment" | "path" | "muxed" | "mint";
  expect: "VERIFIED" | "REJECTED";
  reasons?: string[];
}

interface ApiPayment {
  id: string;
  amount: string;
  memo: string | null;
  memoType: string;
  asset: { code: string; issuer: string | null };
  matches: { outcome: string; reasons: string[]; eventId: string | null }[];
}

const failures: string[] = [];
function check(ok: boolean, message: string): void {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${message}`);
}

// Chaos option: the receiver answers 500 for this long after the first payment, then recovers.
const RECEIVER_FAIL_SECONDS = parseInt(process.env.RECEIVER_FAIL_SECONDS ?? "0", 10);

const receiver = await startMockReceiver({ port: RECEIVER_PORT });
console.log(`mock receiver on ${receiver.url}`);

console.log("creating developer, endpoint and testnet accounts...");
const { api } = await developerClient(
  `scenario-${Date.now()}@example.com`,
  "scenario demo passphrase",
);
const { endpoint, secret } = await api.post<{ endpoint: { id: string }; secret: string }>(
  "/v1/endpoints",
  {
    url: `${receiver.url}/webhooks`,
    description: "scenario mock receiver",
  },
);

const payer = Keypair.random();
const wallet = Keypair.random();
const issuer = Keypair.random(); // stands in for Circle: the issuer the watch accepts
const fakeIssuer = Keypair.random(); // counterfeit "USDC"
await fundWithFriendbot(payer, wallet, issuer, fakeIssuer);

const usdc = new Asset("USDC", issuer.publicKey());
const fake = new Asset("USDC", fakeIssuer.publicKey());
const trust = [Operation.changeTrust({ asset: usdc }), Operation.changeTrust({ asset: fake })];
await Promise.all([submit(payer, trust), submit(wallet, trust)]);
await Promise.all([
  submit(issuer, [
    Operation.payment({ destination: payer.publicKey(), asset: usdc, amount: "100000" }),
  ]),
  submit(fakeIssuer, [
    Operation.payment({ destination: payer.publicKey(), asset: fake, amount: "100000" }),
  ]),
]);

// Everything above happened before the watch exists, so none of it may be recorded.
const { watch, warnings } = await api.post<{
  watch: { id: string; startLedger: number };
  warnings: string[];
}>("/v1/watches", {
  walletAddress: wallet.publicKey(),
  label: "Scenario checkout",
  endpointId: endpoint.id,
  assets: [{ code: "USDC", issuer: issuer.publicKey() }],
  amountRule: { kind: "min", amount: "10" },
  memoRule: { kind: "present" },
  eventTypes: ["payment.received", "payment.rejected"],
});
console.log(
  `watch ${watch.id} on ${wallet.publicKey()} from ledger ${watch.startLedger}; warnings: ${JSON.stringify(warnings)}`,
);
check(warnings.length === 0, "wallet with account and trustline has no warnings");
await sleep(8_000); // let the worker pick the watch up and the start ledger pass

// Every case has a unique amount, which is how results are matched back to cases.
const cases: Case[] = [
  {
    name: "normal payment, text memo",
    amount: "10",
    asset: "usdc",
    memo: Memo.text("order-1001"),
    expect: "VERIFIED",
  },
  {
    name: "normal payment, larger amount",
    amount: "25.5",
    asset: "usdc",
    memo: Memo.text("order-1002"),
    expect: "VERIFIED",
  },
  {
    name: "wrong asset (XLM)",
    amount: "11",
    asset: "xlm",
    memo: Memo.text("order-1003"),
    expect: "REJECTED",
    reasons: ["WRONG_ASSET"],
  },
  {
    name: "fake-issuer USDC",
    amount: "12",
    asset: "fake",
    memo: Memo.text("order-1004"),
    expect: "REJECTED",
    reasons: ["WRONG_ISSUER"],
  },
  {
    name: "amount just below the minimum",
    amount: "9.9999999",
    asset: "usdc",
    memo: Memo.text("order-1005"),
    expect: "REJECTED",
    reasons: ["AMOUNT_BELOW_MIN"],
  },
  {
    name: "memo missing",
    amount: "13",
    asset: "usdc",
    expect: "REJECTED",
    reasons: ["MEMO_MISSING"],
  },
  { name: "ID memo", amount: "14", asset: "usdc", memo: Memo.id("424242"), expect: "VERIFIED" },
  {
    name: "hash memo",
    amount: "15",
    asset: "usdc",
    memo: Memo.hash("ab".repeat(32)),
    expect: "VERIFIED",
  },
  {
    name: "path payment",
    amount: "16",
    asset: "usdc",
    memo: Memo.text("order-1009"),
    via: "path",
    expect: "VERIFIED",
  },
  { name: "M-address destination", amount: "17", asset: "usdc", via: "muxed", expect: "VERIFIED" },
  {
    name: "issuer mint",
    amount: "18",
    asset: "usdc",
    memo: Memo.text("order-1011"),
    via: "mint",
    expect: "VERIFIED",
  },
  {
    name: "every rule fails at once",
    amount: "1",
    asset: "xlm",
    expect: "REJECTED",
    reasons: ["WRONG_ASSET", "AMOUNT_BELOW_MIN", "MEMO_MISSING"],
  },
  ...Array.from({ length: 8 }, (_, i): Case => ({
    name: `burst payment ${i + 1}`,
    amount: String(30 + i),
    asset: "usdc",
    memo: Memo.text(`burst-${i + 1}`),
    expect: "VERIFIED",
  })),
];

const muxedWallet = new MuxedAccount(new Account(wallet.publicKey(), "0"), "777").accountId();
const assets = { usdc, fake, xlm: Asset.native() };

if (RECEIVER_FAIL_SECONDS > 0) {
  receiver.setMode("500");
  receiverHealthyAt = Number.MAX_SAFE_INTEGER;
  setTimeout(() => {
    receiver.setMode("ok");
    receiverHealthyAt = Date.now();
    console.log(`  receiver is back after ${RECEIVER_FAIL_SECONDS} s of 500s`);
  }, RECEIVER_FAIL_SECONDS * 1000);
  console.log(`receiver will answer 500 for ${RECEIVER_FAIL_SECONDS} s`);
}
console.log(`sending ${cases.length} payments...`);
for (const [index, c] of cases.entries()) {
  const asset = assets[c.asset];
  const destination = c.via === "muxed" ? muxedWallet : wallet.publicKey();
  const operation =
    c.via === "path"
      ? Operation.pathPaymentStrictSend({
          sendAsset: asset,
          sendAmount: c.amount,
          destination,
          destAsset: asset,
          destMin: c.amount,
          path: [],
        })
      : Operation.payment({ destination, asset, amount: c.amount });
  await submit(c.via === "mint" ? issuer : payer, [operation], c.memo);
  console.log(`  sent ${String(index + 1).padStart(2)}/${cases.length}: ${c.name}`);
}

console.log("waiting for the worker to record and deliver everything...");
const walletQuery = `/v1/payments?wallet=${wallet.publicKey()}&limit=100`;
const deadline = Date.now() + WAIT_MS;
// Only requests the receiver answered with 200 count as delivered.
const okRequests = () => receiver.requests.filter((r) => r.receivedAt >= receiverHealthyAt);
const delivered = () => new Set(okRequests().map((r) => r.headers["webhook-id"])).size;
while (Date.now() < deadline) {
  const seen = (await api.get<{ data: ApiPayment[] }>(walletQuery)).data;
  if (seen.length >= cases.length && delivered() >= cases.length) break;
  await sleep(2_000);
}
await sleep(5_000); // anything extra (a duplicate payment or event) would show up now
const payments = (await api.get<{ data: ApiPayment[] }>(walletQuery)).data;

console.log("\nresults:");
check(
  payments.length === cases.length,
  `exactly ${cases.length} payments recorded (got ${payments.length})`,
);
for (const c of cases) {
  const normalized = `${c.amount.split(".")[0]}.${(c.amount.split(".")[1] ?? "").padEnd(7, "0")}`;
  const found = payments.filter((p) => p.amount === normalized);
  const match = found[0]?.matches[0];
  const reasonsOk = JSON.stringify(match?.reasons ?? null) === JSON.stringify(c.reasons ?? []);
  check(
    found.length === 1 && match?.outcome === c.expect && reasonsOk,
    `${c.name}: ${c.expect}${c.reasons ? ` [${c.reasons.join(", ")}]` : ""}` +
      (found.length === 1 && match
        ? match.outcome === c.expect && reasonsOk
          ? ""
          : ` (got ${match.outcome} [${match.reasons.join(", ")}])`
        : ` (found ${found.length} rows)`),
  );
}
const muxed = payments.find((p) => p.amount === "17.0000000");
check(
  muxed?.memoType === "id" && muxed.memo === "777",
  "M-address payment arrives on the base wallet with mux ID 777",
);
const hashed = payments.find((p) => p.amount === "15.0000000");
check(
  hashed?.memoType === "hash" && hashed.memo === "ab".repeat(32),
  "hash memo is reported as hex",
);

const eventIds = new Set(
  payments.flatMap((p) => p.matches.map((m) => m.eventId)).filter((id) => id !== null),
);
const receivedIds = new Set(okRequests().map((r) => r.headers["webhook-id"]));
check(eventIds.size === cases.length, `one webhook event per payment (${eventIds.size})`);
check(
  receivedIds.size === cases.length && [...eventIds].every((id) => receivedIds.has(id)),
  `receiver got ${receivedIds.size} distinct webhooks in ${receiver.requests.length} requests (duplicates only ever reuse a Webhook-Id)`,
);
check(
  receiver.requests.every((r) => verifyWebhook(secret, r.headers, r.body)),
  "every webhook signature verifies with the endpoint secret",
);
const types = receiver.requests.map((r) => (JSON.parse(r.body) as { type: string }).type);
const expectedRejected = cases.filter((c) => c.expect === "REJECTED").length;
check(
  new Set(
    receiver.requests
      .filter((_, i) => types[i] === "payment.rejected")
      .map((r) => r.headers["webhook-id"]),
  ).size === expectedRejected,
  `${expectedRejected} payment.rejected and ${cases.length - expectedRejected} payment.received webhooks`,
);

await receiver.close();
if (failures.length > 0) {
  console.error(`\nSCENARIO FAILED: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(
  `\nSCENARIO PASSED: ${cases.length} payments, ${receivedIds.size} webhooks delivered and verified`,
);
process.exit(0);
