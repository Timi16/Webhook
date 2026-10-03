// Shared helpers for the repo scripts: a tiny API client and testnet transaction helpers.
import {
  BASE_FEE,
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
  type Memo,
  type xdr,
} from "@stellar/stellar-sdk";

export const API_URL = process.env.API_URL ?? "http://localhost:4000";
export const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
export const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";

export const server = new rpc.Server(RPC_URL);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API responded ${status}: ${JSON.stringify(body)}`);
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

function client(headers: Record<string, string>): ApiClient {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, parsed);
    return parsed as T;
  };
  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) };
}

/** Signs up (or logs in if the account exists) and returns a client authenticated with a new API key. */
export async function developerClient(
  email: string,
  password: string,
): Promise<{ api: ApiClient; key: string }> {
  const credentials = JSON.stringify({ email, password });
  const headers = { "content-type": "application/json", origin: DASHBOARD_ORIGIN };
  let res = await fetch(`${API_URL}/auth/signup`, { method: "POST", headers, body: credentials });
  if (res.status === 409)
    res = await fetch(`${API_URL}/auth/login`, { method: "POST", headers, body: credentials });
  if (!res.ok) throw new ApiError(res.status, await res.json());
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("no session cookie returned");
  const session = client({ cookie, origin: DASHBOARD_ORIGIN });
  const { key } = await session.post<{ key: string }>("/v1/api-keys", {
    name: `script ${new Date().toISOString()}`,
  });
  return { api: client({ authorization: `Bearer ${key}` }), key };
}

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(
        `  ${label} failed (${err instanceof Error ? err.message : String(err)}), retrying`,
      );
      await sleep(2_000 * i);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fundWithFriendbot(...keypairs: Keypair[]): Promise<void> {
  await Promise.all(
    keypairs.map((kp) =>
      retry("friendbot", async () => {
        const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
        if (!res.ok) throw new Error(`friendbot responded ${res.status}`);
      }),
    ),
  );
}

/** Builds, signs, submits and waits for a classic transaction. Returns its hash. */
export async function submit(
  source: Keypair,
  operations: xdr.Operation[],
  memo?: Memo,
): Promise<string> {
  return retry("transaction", async () => {
    const account = await server.getAccount(source.publicKey());
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 100),
      networkPassphrase: Networks.TESTNET,
    });
    for (const operation of operations) builder.addOperation(operation);
    if (memo) builder.addMemo(memo);
    const tx = builder.setTimeout(120).build();
    tx.sign(source);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") throw new Error(`rejected: ${JSON.stringify(sent.errorResult)}`);
    const done = await server.pollTransaction(sent.hash, { attempts: 40 });
    if (done.status !== "SUCCESS") throw new Error(`transaction ${sent.hash} ended ${done.status}`);
    return sent.hash;
  });
}
