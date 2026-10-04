"use client";

import { AMOUNT_PATTERN, isValidPublicKey } from "@webhook/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { SetupFrame } from "@/components/setup";
import { ErrorAlert } from "@/components/ui";
import { trustFor, useAccounts } from "@/lib/accounts";
import { api } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { amountRuleShort, assetCodes, memoRuleShort } from "@/lib/rules";
import {
  draftAsset,
  useSetup,
  watchBody,
  type Setup,
  type SetupAsset,
  type WalletDraft,
} from "@/lib/setup";
import type { Watch } from "@/lib/types";

const ASSETS: { value: SetupAsset; sub: string }[] = [
  { value: "USDC", sub: "testnet" },
  { value: "XLM", sub: "native" },
  { value: "Custom", sub: "code + issuer" },
];
const LAB_URL = "https://lab.stellar.org/account/create?$=network$id=testnet";

function Preview({
  label,
  address,
  code,
  amount,
  memo = "ANY",
  sender = "ANYONE",
}: {
  label: string;
  address: string | null;
  code: string;
  amount: string;
  memo?: string;
  sender?: string;
}) {
  return (
    <div className="rcpt-wrap">
      <div className="rcpt" aria-label="Preview of what this watch will check">
        <div className="c">
          <b>Watch preview</b>
          <br />
          {(label || "Untitled watch").toUpperCase()}
        </div>
        <hr />
        <div className="r">
          <span>WALLET</span>
          <span>{address ? shortAddress(address) : "—"}</span>
        </div>
        <div className="r">
          <span>NETWORK</span>
          <span>TESTNET</span>
        </div>
        <hr />
        <div className="r">
          <span>ASSET</span>
          <span>{code}</span>
        </div>
        <div className="r">
          <span>AMOUNT</span>
          <span>{amount}</span>
        </div>
        <div className="r">
          <span>MEMO</span>
          <span>{memo}</span>
        </div>
        <div className="r">
          <span>SENDER</span>
          <span>{sender}</span>
        </div>
        <hr className="dbl" />
        <div className="c" style={{ fontSize: 12 }}>
          Every matching payment fires
          <br />
          <span className="hl">payment.received</span>
        </div>
      </div>
    </div>
  );
}

function LabCard() {
  return (
    <div className="wz-card is-yellow">
      <h3>
        <Icon name="wallet" size={18} />
        No testnet wallet yet?
      </h3>
      <p>
        Create one in Stellar Lab and fund it with Friendbot. It takes a minute and costs nothing.
      </p>
      <a className="wh-btn is-sm" href={LAB_URL} target="_blank" rel="noopener">
        Open Stellar Lab
        <Icon name="external-link" size={14} />
      </a>
    </div>
  );
}

/** Step 1 once a watch exists: the wallet can't change, so show what is being watched. */
function Watching({ watch }: { watch: Watch }) {
  const code = assetCodes(watch);
  return (
    <div className="wz-grid">
      <div className="wz-main">
        <span className="wz-eyebrow">Step 1 · Wallet</span>
        <h1>You're watching {watch.label ?? shortAddress(watch.walletAddress)}</h1>
        <p className="lede">
          This wallet is already set up. To change its rules or watch another wallet, use Watches in
          the dashboard.
        </p>
        <section className="wh-panel">
          <header>
            <span className="h">Wallet</span>
            <span className="wh-badge is-ok">
              <Icon name="check" size={14} className="ic-b" />
              done
            </span>
          </header>
          <div className="panel-body">
            <div className="wh-secret" style={{ maxWidth: "100%" }}>
              <code>{watch.walletAddress}</code>
            </div>
            <div className="wz-inline">
              <Link className="wh-btn is-sm" href={`/watches/edit?id=${watch.id}`}>
                <Icon name="pencil" size={14} />
                Edit rules
              </Link>
            </div>
          </div>
        </section>
        <div className="wz-actions">
          <Link className="wh-btn is-ghost" href="/onboarding">
            <Icon name="arrow-left" />
            Back to checklist
          </Link>
          <div className="r">
            <Link className="wh-btn is-primary" href="/onboarding/endpoint">
              Continue
              <Icon name="arrow-right" />
            </Link>
          </div>
        </div>
      </div>
      <aside className="wz-side">
        <Preview
          label={watch.label ?? ""}
          address={watch.walletAddress}
          code={code}
          amount={amountRuleShort(watch.amountRule).toUpperCase()}
          memo={memoRuleShort(watch.memoRule).toUpperCase()}
          sender={
            watch.senderAllowlist.length === 0
              ? "ANYONE"
              : `${watch.senderAllowlist.length} ALLOWED`
          }
        />
      </aside>
    </div>
  );
}

function WalletForm({ setup }: { setup: Setup }) {
  const router = useRouter();
  const saved = setup.draft.wallet;
  const [label, setLabel] = useState(saved?.label ?? "");
  const [addr, setAddr] = useState(saved?.address ?? "");
  const [refused, setRefused] = useState(false);
  const [asset, setAsset] = useState<SetupAsset>(saved?.asset ?? "USDC");
  const [customCode, setCustomCode] = useState(saved?.customCode ?? "");
  const [customIssuer, setCustomIssuer] = useState(saved?.customIssuer ?? "");
  const [minimum, setMinimum] = useState(saved ? saved.minAmount !== "" : false);
  const [minAmount, setMinAmount] = useState(saved?.minAmount ?? "");

  const [state, problem] = ((): ["empty" | "typing" | "ok" | "bad" | "refused", string] => {
    if (refused && !addr) return ["refused", ""];
    if (!addr) return ["empty", ""];
    if (addr[0] !== "G")
      return ["bad", `A public key starts with G. This one starts with ${addr[0]}.`];
    if (addr.length < 56) return ["typing", ""];
    if (addr.length > 56)
      return ["bad", `A public key is 56 characters. This one is ${addr.length}.`];
    if (!isValidPublicKey(addr))
      return [
        "bad",
        "The checksum doesn't match, so there's a typo somewhere. Copy the address again from the wallet.",
      ];
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

  const wallet: WalletDraft = {
    label,
    address: addr,
    asset,
    customCode,
    customIssuer,
    minAmount: minimum ? minAmount.trim() : "",
  };
  const chosen = draftAsset(wallet);
  const code = chosen.code || "asset";
  const accounts = useAccounts(state === "ok" ? [addr] : []);
  const trust = trustFor(accounts.get(addr), [chosen]);
  const customOk =
    asset !== "Custom" || (customCode.trim() !== "" && isValidPublicKey(customIssuer.trim()));
  const amountOk = !minimum || AMOUNT_PATTERN.test(minAmount.trim());
  const canContinue = state === "ok" && customOk && amountOk;

  // With an endpoint already in the account the watch can be created now; otherwise step 2 does it.
  const next = useAction(async () => {
    if (setup.endpoint) {
      await api<{ watch: Watch }>("/v1/watches", {
        method: "POST",
        body: watchBody(wallet, setup.endpoint.id),
      });
      setup.saveDraft({ wallet: undefined });
      router.push("/onboarding/test");
    } else {
      setup.saveDraft({ wallet });
      router.push("/onboarding/endpoint");
    }
  });

  return (
    <div className="wz-grid">
      <div className="wz-main">
        <span className="wz-eyebrow">Step 1 · Wallet</span>
        <h1>Which wallet should we watch?</h1>
        <p className="lede">
          Paste the public address that receives payments. We'll check its trustlines and start
          reading every ledger for payments to it.
        </p>
        <section className="wh-panel">
          <header>
            <span className="h">Wallet</span>
          </header>
          <div className="panel-body">
            <div className="wh-field">
              <label htmlFor="label">Give it a name</label>
              <input
                id="label"
                className="wh-input"
                maxLength={100}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Shop till"
              />
              <span className="hint">
                Only you see this. It shows in lists and in webhook metadata.
              </span>
            </div>
            <div className="wh-field">
              <label htmlFor="addr">Public address</label>
              <input
                id="addr"
                className="wh-input mono"
                value={addr}
                onChange={(e) => onAddress(e.target.value)}
                aria-invalid={state === "bad" || state === "refused"}
                aria-describedby="addr-help"
                spellCheck={false}
                autoComplete="off"
                placeholder="G… 56 characters"
              />
              <div id="addr-help" aria-live="polite">
                {state === "empty" && (
                  <div className="wh-help">
                    Starts with G, 56 characters. Never paste the secret key.
                  </div>
                )}
                {state === "typing" && (
                  <div className="wh-help">Keep going: {addr.length} of 56 characters.</div>
                )}
                {state === "bad" && (
                  <div className="wh-help is-bad">
                    <Icon name="alert-circle" />
                    <span>{problem}</span>
                  </div>
                )}
                {state === "refused" && (
                  <div className="wh-refusal" role="alert">
                    <Icon name="shield-check" />
                    <div>
                      <strong>That was a secret key, so we cleared it.</strong>
                      <br />
                      Secret keys start with S and give full control of the wallet. Use the public
                      address, which starts with G. If that key is real, move the funds to a new
                      wallet.
                    </div>
                  </div>
                )}
                {state === "ok" && (
                  <div className="wh-col" style={{ gap: 6 }}>
                    <div className="wh-help is-ok">
                      <Icon name="check-circle" />
                      Valid public key
                    </div>
                    {trust.state === "ok" && (
                      <div className="wh-help">
                        <Icon name="shield" />
                        <span>
                          Trustline:{" "}
                          <span className="mono" style={{ color: "var(--ok)" }}>
                            {chosen.issuer === null ? "XLM native" : `${code} ok`}
                          </span>
                        </span>
                      </div>
                    )}
                    {trust.state === "missing" && (
                      <div className="wh-help is-warn">
                        <Icon name="alert-triangle" />
                        <span>
                          No {code} trustline yet. {code} payments will fail until the wallet adds
                          one.
                        </span>
                      </div>
                    )}
                    {trust.state === "no-account" && (
                      <div className="wh-help is-warn">
                        <Icon name="alert-triangle" />
                        <span>
                          This account doesn't exist on testnet yet. Fund it with Friendbot to
                          activate it. You can still continue.
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
            <span className="h">Which payments count?</span>
          </header>
          <div className="panel-body">
            <div className="wh-field">
              <span
                className="fine"
                style={{ color: "var(--ink)", font: "600 13px/16px var(--font-sans)" }}
              >
                Asset
              </span>
              <div className="wz-pills" role="radiogroup" aria-label="Asset">
                {ASSETS.map((option) => (
                  <button
                    type="button"
                    className="wz-pill"
                    role="radio"
                    key={option.value}
                    aria-checked={asset === option.value}
                    onClick={() => setAsset(option.value)}
                  >
                    {option.value}
                    <span className="sub">{option.sub}</span>
                  </button>
                ))}
              </div>
            </div>
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
                    placeholder="G… issuing account"
                  />
                </div>
              </div>
            )}
            <div className="wh-field">
              <span
                className="fine"
                style={{ color: "var(--ink)", font: "600 13px/16px var(--font-sans)" }}
              >
                Amount
              </span>
              <div className="wz-pills" role="radiogroup" aria-label="Amount rule">
                <button
                  type="button"
                  className="wz-pill"
                  role="radio"
                  aria-checked={!minimum}
                  onClick={() => setMinimum(false)}
                >
                  Any amount
                </button>
                <button
                  type="button"
                  className="wz-pill"
                  role="radio"
                  aria-checked={minimum}
                  onClick={() => setMinimum(true)}
                >
                  Minimum
                </button>
              </div>
              {minimum && (
                <div className="wz-inline">
                  <input
                    className="wh-input mono"
                    style={{ width: 190 }}
                    aria-label="Minimum amount"
                    inputMode="decimal"
                    placeholder="50"
                    value={minAmount}
                    aria-invalid={minAmount !== "" && !amountOk ? true : undefined}
                    onChange={(e) => setMinAmount(e.target.value)}
                  />
                  <span className="wh-reason">{code}</span>
                </div>
              )}
              <span className="hint">
                Memo rules and sender allowlists come later, in the watch settings. Keep it open for
                your first test.
              </span>
            </div>
          </div>
        </section>
        {next.error && <ErrorAlert error={next.error} title="Couldn't create this watch." />}
        <div className="wz-actions">
          <Link className="wh-btn is-ghost" href="/onboarding">
            <Icon name="arrow-left" />
            Back to checklist
          </Link>
          <div className="r">
            <span className="note">
              {canContinue
                ? "Looks good"
                : state === "ok"
                  ? "Finish the rules to continue"
                  : "Fix the address to continue"}
            </span>
            <button
              className="wh-btn is-primary"
              type="button"
              disabled={!canContinue || next.pending}
              onClick={() => void next.run()}
            >
              Save and continue
              <Icon name="arrow-right" />
            </button>
          </div>
        </div>
      </div>
      <aside className="wz-side">
        <Preview
          label={label}
          address={state === "ok" ? addr : null}
          code={code.toUpperCase()}
          amount={minimum ? `≥ ${minAmount || "…"}` : "ANY"}
        />
        <LabCard />
      </aside>
    </div>
  );
}

export default function WalletStep() {
  const setup = useSetup();
  return (
    <SetupFrame setup={setup} step="wallet">
      {setup.watch ? <Watching watch={setup.watch} /> : <WalletForm setup={setup} />}
    </SetupFrame>
  );
}
