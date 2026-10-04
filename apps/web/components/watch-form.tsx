"use client";

import { AMOUNT_PATTERN, isValidContractAddress, isValidPublicKey } from "@webhook/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { trustFor, useAccounts } from "@/lib/accounts";
import { api, type ApiError } from "@/lib/api";
import { USDC, USDC_ISSUER, XLM } from "@/lib/constants";
import { shortAddress, shortUrl } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import type { Endpoint, Watch } from "@/lib/types";
import { Icon } from "./icons";
import { CurlButton } from "./curl";
import { CopyButton, ErrorAlert, PageHead } from "./ui";

type AssetChoice = "USDC testnet" | "XLM" | "Custom";
type AmountKind = Watch["amountRule"]["kind"];
type MemoKind = Watch["memoRule"]["kind"];
type MemoType = "text" | "id" | "hash";

const ASSETS: AssetChoice[] = ["USDC testnet", "XLM", "Custom"];
const AMOUNT_KINDS: AmountKind[] = ["any", "exact", "min", "max", "range"];
const MEMO_KINDS: MemoKind[] = ["any", "equals", "present", "absent"];
const MEMO_TYPES: MemoType[] = ["text", "id", "hash"];
const MEMO_HINTS: Record<MemoKind, string> = {
  any: "Memo is ignored.",
  present: "The payment must carry a memo of any value.",
  absent: "The payment must have no memo.",
  equals: "",
};

/** Plain words for the validation codes the API returns for a watch. */
const ISSUES: Record<string, string> = {
  invalid_stellar_address: "That isn't a valid Stellar address.",
  secret_key_rejected: "That is a secret key. Use the public address, which starts with G.",
  invalid_amount: "Use a number with up to 7 decimal places, like 10 or 10.5.",
  amount_out_of_range: "The amount must be more than 0.",
  min_greater_than_max: "The minimum can't be more than the maximum.",
  memo_text_too_long: "A text memo holds at most 28 bytes.",
  invalid_memo_id: "An ID memo is a whole number.",
  invalid_memo_hash: "A hash memo is 64 hex characters.",
  invalid_asset_code: "An asset code is 1 to 12 letters or digits.",
  issuer_required: "Enter the issuer's address.",
};

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="wh-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          key={option}
          aria-checked={option === value}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function initialAsset(watch: Watch | undefined): AssetChoice {
  const asset = watch?.assets[0];
  if (!asset) return "USDC testnet";
  if (asset.issuer === null) return "XLM";
  return asset.code === "USDC" && asset.issuer === USDC_ISSUER ? "USDC testnet" : "Custom";
}

/** Create or edit a watch. `watch` set means edit: the wallet address cannot change. */
export function WatchForm({ watch }: { watch?: Watch }) {
  const router = useRouter();
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints");

  const [label, setLabel] = useState(watch?.label ?? "");
  const [addr, setAddr] = useState(watch?.walletAddress ?? "");
  const [refused, setRefused] = useState(false);
  const [asset, setAsset] = useState<AssetChoice>(initialAsset(watch));
  const [customCode, setCustomCode] = useState(
    asset === "Custom" ? (watch?.assets[0]?.code ?? "") : "",
  );
  const [customIssuer, setCustomIssuer] = useState(
    asset === "Custom" ? (watch?.assets[0]?.issuer ?? "") : "",
  );
  const rule = watch?.amountRule;
  const [amountKind, setAmountKind] = useState<AmountKind>(rule?.kind ?? "any");
  const [amount, setAmount] = useState(rule && "amount" in rule ? rule.amount : "");
  const [amountMin, setAmountMin] = useState(rule?.kind === "range" ? rule.min : "");
  const [amountMax, setAmountMax] = useState(rule?.kind === "range" ? rule.max : "");
  const memo = watch?.memoRule;
  const [memoKind, setMemoKind] = useState<MemoKind>(memo?.kind ?? "any");
  const [memoValue, setMemoValue] = useState(memo?.kind === "equals" ? memo.value : "");
  const [memoType, setMemoType] = useState<MemoType>(memo?.kind === "equals" ? memo.type : "text");
  const [senders, setSenders] = useState<string[]>(watch?.senderAllowlist ?? []);
  const [senderInput, setSenderInput] = useState("");
  const [senderError, setSenderError] = useState<string>();
  const [endpointId, setEndpointId] = useState(watch?.endpointId ?? "");
  const [notifyRejected, setNotifyRejected] = useState(
    watch?.eventTypes.includes("payment.rejected") ?? false,
  );

  // Wallet address: the same states the design walks through as you type.
  const [addressState, addressProblem] = ((): [
    "empty" | "typing" | "ok" | "bad" | "refused",
    string,
  ] => {
    if (refused && !addr) return ["refused", ""];
    if (!addr) return ["empty", ""];
    if (addr[0] !== "G")
      return ["bad", `A public key starts with G. This one starts with ${addr[0]}.`];
    if (addr.length < 56) return ["typing", ""];
    if (addr.length > 56)
      return ["bad", `A public key is 56 characters. This one is ${addr.length}.`];
    if (!isValidPublicKey(addr)) {
      return [
        "bad",
        "The checksum doesn't match, so there's a typo somewhere. Copy the address again from the wallet.",
      ];
    }
    return ["ok", ""];
  })();

  const onAddress = (raw: string) => {
    const value = raw.replace(/\s+/g, "");
    // A secret key must never sit in the field, the page or a request.
    if (/^S[A-Z2-7]{8,}/.test(value)) {
      setAddr("");
      setRefused(true);
    } else {
      setAddr(value);
      setRefused(false);
    }
  };

  const chosenAsset =
    asset === "XLM"
      ? XLM
      : asset === "USDC testnet"
        ? USDC
        : { code: customCode.trim(), issuer: customIssuer.trim() };
  const code = chosenAsset.code || "asset";
  const accounts = useAccounts(addressState === "ok" ? [addr] : []);
  const trust = trustFor(accounts.get(addr), [chosenAsset]);

  const amountRule =
    amountKind === "any"
      ? { kind: "any" as const }
      : amountKind === "range"
        ? { kind: "range" as const, min: amountMin.trim(), max: amountMax.trim() }
        : { kind: amountKind, amount: amount.trim() };
  const memoRule =
    memoKind === "equals"
      ? { kind: "equals" as const, value: memoValue, type: memoType }
      : { kind: memoKind };
  const amountSummary =
    amountKind === "any"
      ? "any amount"
      : amountKind === "range"
        ? `${amountMin || "…"} ≤ amount ≤ ${amountMax || "…"} ${code}`
        : `amount ${{ exact: "=", min: "≥", max: "≤" }[amountKind]} ${amount || "…"} ${code}`;
  const memoSummary = {
    any: "any memo",
    present: "memo present",
    absent: "no memo",
    equals: `memo = "${memoValue || "…"}"`,
  }[memoKind];

  const addSender = () => {
    const value = senderInput.trim();
    if (!value) return;
    if (!isValidPublicKey(value) && !isValidContractAddress(value)) {
      setSenderError(
        /^S/.test(value) ? ISSUES.secret_key_rejected : "That isn't a valid G… or C… address.",
      );
      if (/^S/.test(value)) setSenderInput("");
      return;
    }
    if (!senders.includes(value)) setSenders([...senders, value]);
    setSenderInput("");
    setSenderError(undefined);
  };

  const usableEndpoints = endpoints.data?.data ?? [];
  const selectedEndpoint = usableEndpoints.find((e) => e.id === endpointId);
  const amountsFilled =
    amountKind === "any" ||
    (amountKind === "range"
      ? AMOUNT_PATTERN.test(amountMin.trim()) && AMOUNT_PATTERN.test(amountMax.trim())
      : AMOUNT_PATTERN.test(amount.trim()));
  const canSubmit =
    addressState === "ok" &&
    endpointId !== "" &&
    amountsFilled &&
    (memoKind !== "equals" || memoValue !== "") &&
    (asset !== "Custom" || (customCode.trim() !== "" && customIssuer.trim() !== ""));

  const body = {
    label: label.trim() || null,
    endpointId,
    assets: [chosenAsset],
    amountRule,
    memoRule,
    senderAllowlist: senders,
    eventTypes: notifyRejected ? ["payment.received", "payment.rejected"] : ["payment.received"],
  };
  const save = useAction(async () => {
    const saved = watch
      ? await api<{ watch: Watch }>(`/v1/watches/${watch.id}`, { method: "PATCH", body })
      : await api<{ watch: Watch }>("/v1/watches", {
          method: "POST",
          body: { ...body, walletAddress: addr },
        });
    router.replace(`/watches/view?id=${saved.watch.id}`);
  });
  const issue = (error: ApiError | undefined, path: string) => {
    const code = error?.issueFor(path);
    return code ? (ISSUES[code] ?? "Check this value.") : undefined;
  };
  const amountError = issue(save.error, "amountRule");
  const memoError = issue(save.error, "memoRule");
  const assetError = issue(save.error, "assets");
  const explained = amountError ?? memoError ?? assetError;

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (canSubmit) void save.run();
      }}
      style={{ display: "contents" }}
    >
      <PageHead
        back={{
          href: watch ? `/watches/view?id=${watch.id}` : "/watches",
          label: watch ? (watch.label ?? "Watch") : "Watches",
        }}
        title={watch ? "Edit watch" : "Create watch"}
        sub={
          watch
            ? "Changes apply from the next ledger. Webhooks already sent are never rewritten."
            : "Tell us which wallet to watch, what a valid payment looks like, and where to send the webhook."
        }
      />

      <section className="wh-panel">
        <header>
          <span className="h">
            <Icon name="wallet" />
            Wallet
          </span>
        </header>
        <div className="panel-body">
          <div className="form-grid">
            <div className="wh-field">
              <label htmlFor="label">Label</label>
              <input
                id="label"
                className="wh-input"
                maxLength={100}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Shop till"
              />
              <span className="hint">
                Only you see this. Shows up in lists and webhook metadata.
              </span>
            </div>
          </div>
          <div className="wh-field">
            <label htmlFor="addr">Wallet address</label>
            <input
              id="addr"
              className="wh-input mono"
              value={addr}
              onChange={(e) => onAddress(e.target.value)}
              readOnly={watch !== undefined}
              aria-invalid={addressState === "bad" || addressState === "refused"}
              aria-describedby="addr-help"
              spellCheck={false}
              autoComplete="off"
              placeholder="GBJP…CH5P"
            />
            <div id="addr-help" aria-live="polite">
              {watch ? (
                <div className="wh-help">
                  The wallet can't be changed. To watch another wallet, create a new watch.
                </div>
              ) : addressState === "empty" ? (
                <div className="wh-help">
                  Starts with G, 56 characters. Paste the public address, never the secret key.
                </div>
              ) : addressState === "typing" ? (
                <div className="wh-help">Keep going: {addr.length} of 56 characters.</div>
              ) : addressState === "bad" ? (
                <div className="wh-help is-bad">
                  <Icon name="alert-circle" />
                  <span>{addressProblem}</span>
                </div>
              ) : addressState === "refused" ? (
                <div className="wh-refusal" role="alert">
                  <Icon name="shield-check" />
                  <div>
                    <strong>That was a secret key, so we cleared it.</strong>
                    <br />
                    Secret keys start with S and give full control of the wallet. Never paste one
                    anywhere. Use the public address, which starts with G. If this key is real, move
                    the funds to a new wallet.
                  </div>
                </div>
              ) : null}
              {addressState === "ok" && (
                <div className="wh-col" style={{ gap: 6 }}>
                  {!watch && (
                    <div className="wh-help is-ok">
                      <Icon name="check-circle" />
                      Valid public key
                    </div>
                  )}
                  {trust.state === "ok" && (
                    <div className="wh-help">
                      <Icon name="shield" />
                      <span>
                        Trustline:{" "}
                        <span className="mono" style={{ color: "var(--ok)" }}>
                          {chosenAsset.issuer === null ? "XLM native" : `${code} ok`}
                        </span>
                      </span>
                    </div>
                  )}
                  {trust.state === "missing" && (
                    <div className="wh-help is-warn">
                      <Icon name="alert-triangle" />
                      <span>
                        No {code} trustline. {code} payments to this wallet will fail until it adds
                        one. You can still save the watch.
                      </span>
                    </div>
                  )}
                  {trust.state === "no-account" && (
                    <div className="wh-help is-warn">
                      <Icon name="alert-triangle" />
                      <span>
                        This account doesn't exist on testnet yet. Fund it with Friendbot to
                        activate it. You can still save the watch.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="wh-panel">
        <header>
          <span className="h">
            <Icon name="coins" />
            Asset
          </span>
        </header>
        <div className="panel-body">
          <Segmented label="Asset" options={ASSETS} value={asset} onChange={setAsset} />
          {asset === "Custom" && (
            <div className="form-grid">
              <div className="wh-field">
                <label htmlFor="code">Asset code</label>
                <input
                  id="code"
                  className="wh-input mono"
                  maxLength={12}
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value)}
                  placeholder="NGNC"
                />
              </div>
              <div className="wh-field">
                <label htmlFor="issuer">Issuer</label>
                <input
                  id="issuer"
                  className="wh-input mono"
                  spellCheck={false}
                  value={customIssuer}
                  onChange={(e) => setCustomIssuer(e.target.value.replace(/\s+/g, ""))}
                  aria-invalid={assetError ? true : undefined}
                />
                <span className="hint">The issuing account, starts with G.</span>
              </div>
            </div>
          )}
          {asset === "USDC testnet" && (
            <p className="fine" style={{ overflowWrap: "anywhere" }}>
              USDC · issuer {USDC_ISSUER}
            </p>
          )}
          {watch && watch.assets.length > 1 && (
            <div className="wh-help is-warn">
              <Icon name="alert-triangle" />
              <span>
                This watch accepts {watch.assets.length} assets, set through the API. Saving here
                replaces them with the one selected above.
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="wh-panel wh-resp" aria-label="Payment conditions">
        <header>
          <span className="h">
            <Icon name="list-checks" />
            Conditions
          </span>
        </header>
        <div className="wh-rule">
          <span className="name">Amount</span>
          <div className="wh-col">
            <Segmented
              label="Amount rule"
              options={AMOUNT_KINDS}
              value={amountKind}
              onChange={setAmountKind}
            />
            {amountKind === "range" ? (
              <div className="wh-row">
                <input
                  className="wh-input mono"
                  style={{ width: 170 }}
                  aria-label="Minimum amount"
                  inputMode="decimal"
                  placeholder="50"
                  value={amountMin}
                  onChange={(e) => setAmountMin(e.target.value)}
                  aria-invalid={amountError ? true : undefined}
                />
                <span className="muted">to</span>
                <input
                  className="wh-input mono"
                  style={{ width: 170 }}
                  aria-label="Maximum amount"
                  inputMode="decimal"
                  placeholder="500"
                  value={amountMax}
                  onChange={(e) => setAmountMax(e.target.value)}
                  aria-invalid={amountError ? true : undefined}
                />
                <span className="wh-reason">{code}</span>
              </div>
            ) : amountKind === "any" ? (
              <span className="hint">Any amount of the selected asset passes.</span>
            ) : (
              <div className="wh-row">
                <input
                  className="wh-input mono"
                  style={{ width: 170 }}
                  aria-label={
                    { exact: "Exact amount", min: "Minimum amount", max: "Maximum amount" }[
                      amountKind
                    ]
                  }
                  inputMode="decimal"
                  placeholder="50"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={amountError ? true : undefined}
                />
                <span className="wh-reason">{code}</span>
              </div>
            )}
            <span className="hint">
              Up to 7 decimal places. We compare exact amounts, never rounded numbers.
            </span>
          </div>
        </div>
        <div className="wh-rule">
          <span className="name">Memo</span>
          <div className="wh-col">
            <Segmented
              label="Memo rule"
              options={MEMO_KINDS}
              value={memoKind}
              onChange={setMemoKind}
            />
            {memoKind === "equals" ? (
              <div className="wh-row">
                <input
                  className="wh-input mono"
                  style={{ maxWidth: 260 }}
                  aria-label="Memo must equal"
                  placeholder="INV-0412"
                  value={memoValue}
                  onChange={(e) => setMemoValue(e.target.value)}
                  aria-invalid={memoError ? true : undefined}
                />
                <Segmented
                  label="Memo type"
                  options={MEMO_TYPES}
                  value={memoType}
                  onChange={setMemoType}
                />
              </div>
            ) : (
              <span className="hint">{MEMO_HINTS[memoKind]}</span>
            )}
          </div>
        </div>
        <div className="wh-rule">
          <span className="name">Senders</span>
          <div className="wh-col">
            {senders.length > 0 && (
              <div className="chips">
                {senders.map((sender) => (
                  <span
                    key={sender}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <span className="wh-chip">
                      <span className="wh-chip-text" tabIndex={0} aria-label={`Sender ${sender}`}>
                        {shortAddress(sender)}
                      </span>
                      <span className="wh-tip" role="tooltip">
                        {sender}
                      </span>
                      <CopyButton value={sender} label="Copy sender" />
                    </span>
                    <button
                      className="wh-copy"
                      type="button"
                      aria-label={`Remove sender ${shortAddress(sender)}`}
                      onClick={() => setSenders(senders.filter((s) => s !== sender))}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="wh-row">
              <input
                className="wh-input mono"
                style={{ maxWidth: 360 }}
                aria-label="Add sender address"
                placeholder="G… address allowed to pay"
                spellCheck={false}
                value={senderInput}
                aria-invalid={senderError ? true : undefined}
                onChange={(e) => setSenderInput(e.target.value.replace(/\s+/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSender();
                  }
                }}
              />
              <button className="wh-btn" type="button" onClick={addSender}>
                <Icon name="plus" />
                Add sender
              </button>
            </div>
            {senderError ? (
              <span className="wh-help is-bad" role="alert">
                <Icon name="alert-circle" />
                <span>{senderError}</span>
              </span>
            ) : (
              <span className="hint">Optional. Leave empty to accept payments from anyone.</span>
            )}
          </div>
        </div>
        <div className="wh-summary" aria-live="polite">
          Verify when <b>asset is {code}</b>, <b>{amountSummary}</b> and <b>{memoSummary}</b>, from{" "}
          <b>
            {senders.length === 0
              ? "anyone"
              : senders.length === 1
                ? "1 allowed sender"
                : `${senders.length} allowed senders`}
          </b>
        </div>
      </section>

      <section className="wh-panel">
        <header>
          <span className="h">
            <Icon name="webhook" />
            Deliver to
          </span>
          <Link className="wh-btn is-sm is-ghost" href="/endpoints">
            <Icon name="plus" size={14} />
            New endpoint
          </Link>
        </header>
        <div className="panel-body">
          {endpoints.error && !endpoints.data ? (
            <ErrorAlert
              error={endpoints.error}
              title="Couldn't load your endpoints."
              onRetry={endpoints.reload}
            />
          ) : usableEndpoints.length === 0 && endpoints.data ? (
            <div className="wh-help is-warn">
              <Icon name="alert-triangle" />
              <span>
                You don't have an endpoint yet. <Link href="/endpoints">Create one</Link> first; a
                watch needs somewhere to send its webhooks.
              </span>
            </div>
          ) : (
            <div className="opt-list" role="radiogroup" aria-label="Endpoint">
              {usableEndpoints.map((endpoint) => (
                <button
                  type="button"
                  key={endpoint.id}
                  className={endpoint.id === endpointId ? "opt is-on" : "opt"}
                  role="radio"
                  aria-checked={endpoint.id === endpointId}
                  onClick={() => setEndpointId(endpoint.id)}
                >
                  <span className="radio" aria-hidden="true" />
                  <span className="grow url">{shortUrl(endpoint.url)}</span>
                  <span
                    className={`wh-badge ${{ ACTIVE: "is-ok", FAILING: "is-warn", DISABLED: "is-bad" }[endpoint.status]}`}
                  >
                    {endpoint.status.toLowerCase()}
                  </span>
                </button>
              ))}
            </div>
          )}
          {selectedEndpoint && selectedEndpoint.status !== "ACTIVE" && (
            <div className="wh-help is-warn">
              <Icon name="alert-triangle" />
              <span>
                {selectedEndpoint.status === "FAILING"
                  ? "This endpoint is failing right now. Deliveries will retry, but fix it first."
                  : "This endpoint is disabled. Nothing will be delivered until you re-enable it."}
              </span>
            </div>
          )}
          <label className="wh-check">
            <input
              type="checkbox"
              checked={notifyRejected}
              onChange={(e) => setNotifyRejected(e.target.checked)}
            />
            <span>
              Also send <span className="mono">payment.rejected</span> when a payment fails these
              rules. By default you only hear about payments that pass.
            </span>
          </label>
        </div>
      </section>

      {save.error && (
        <ErrorAlert
          error={save.error}
          title={explained ?? (watch ? "Couldn't save this watch." : "Couldn't create this watch.")}
        />
      )}
      <div className="wh-row" style={{ justifyContent: "flex-end" }}>
        {canSubmit && (
          <CurlButton
            method={watch ? "PATCH" : "POST"}
            path={watch ? `/v1/watches/${watch.id}` : "/v1/watches"}
            body={watch ? body : { ...body, walletAddress: addr }}
          />
        )}
        <Link
          className="wh-btn is-ghost"
          href={watch ? `/watches/view?id=${watch.id}` : "/watches"}
        >
          Cancel
        </Link>
        <button className="wh-btn is-primary" type="submit" disabled={!canSubmit || save.pending}>
          <Icon name="check" />
          {save.pending ? "Saving…" : watch ? "Save changes" : "Create watch"}
        </button>
      </div>
    </form>
  );
}
