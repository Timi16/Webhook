"use client";

import Link from "next/link";
import { Icon } from "@/components/icons";
import { useSession } from "@/components/session";
import { SetupFrame } from "@/components/setup";
import { duration, shortAddress, shortUrl } from "@/lib/format";
import { useSetup } from "@/lib/setup";

export default function DonePage() {
  const setup = useSetup();
  const { developer } = useSession();
  const { watch, endpoint, test, payment, doneCount } = setup;
  const complete = doneCount === 4;
  const outcome = payment?.matches.find((m) => m.watchId === watch?.id)?.outcome;
  const name = watch ? (watch.label ?? shortAddress(watch.walletAddress)) : "your wallet";

  return (
    <SetupFrame setup={setup}>
      <div className="wz-done-hero">
        <div className="wz-main">
          <span className="wz-eyebrow">
            {complete && <Icon name="check" size={14} className="ic-b" />}
            {complete ? "Setup complete" : `${doneCount} of 4 steps done`}
          </span>
          {complete ? (
            <h1>
              You're live on <mark>testnet.</mark>
            </h1>
          ) : (
            <h1>
              Almost <mark>there.</mark>
            </h1>
          )}
          <p className="lede">
            {complete
              ? `Every payment to ${name} is now checked against your rules and delivered to your server as a signed webhook. Here's what you set up.`
              : "You can finish the remaining steps any time. Here's where things stand."}
          </p>
          <div className="wz-actions" style={{ justifyContent: "flex-start" }}>
            <Link className="wh-btn is-primary" href="/overview">
              Go to dashboard
              <Icon name="arrow-right" />
            </Link>
            {watch ? (
              <Link className="wh-btn" href={`/watches/view?id=${watch.id}`}>
                View your watch
              </Link>
            ) : (
              <Link className="wh-btn" href="/onboarding">
                Back to checklist
              </Link>
            )}
          </div>
        </div>
        <div style={{ position: "relative" }}>
          <span className="wz-sticker" aria-hidden="true">
            <span>
              <b>{doneCount}/4</b>
              <span>steps done</span>
            </span>
          </span>
          <div className="rcpt-wrap wz-print">
            <div className="rcpt" aria-label="Setup receipt">
              <div className="c">
                <b>Setup receipt</b>
                <br />
                {developer.name ?? developer.email.split("@")[0]}
                <br />
                Stellar Testnet
              </div>
              <hr />
              <div className="r">
                <span>01 WALLET</span>
                <span className={watch ? "pass" : "fail"}>{watch ? "DONE" : "TO DO"}</span>
              </div>
              {watch && (
                <div className="r">
                  <span>&nbsp;&nbsp;&nbsp;{watch.label ?? "Wallet"}</span>
                  <span>{shortAddress(watch.walletAddress)}</span>
                </div>
              )}
              <div className="r">
                <span>02 ENDPOINT</span>
                <span className={endpoint ? "pass" : "fail"}>{endpoint ? "DONE" : "TO DO"}</span>
              </div>
              {endpoint && (
                <div className="r">
                  <span>&nbsp;&nbsp;&nbsp;URL</span>
                  <span>{shortUrl(endpoint.url)}</span>
                </div>
              )}
              <div className="r">
                <span>03 TEST WEBHOOK</span>
                <span className={test ? "pass" : "fail"}>{test ? `${test.statusCode} OK` : "SKIPPED"}</span>
              </div>
              {test && (
                <div className="r">
                  <span>&nbsp;&nbsp;&nbsp;Round trip</span>
                  <span>{duration(test.durationMs)}</span>
                </div>
              )}
              <div className="r">
                <span>04 FIRST PAYMENT</span>
                <span className={outcome === "VERIFIED" ? "pass" : "fail"}>{outcome ?? (payment ? "SEEN" : "WAITING")}</span>
              </div>
              <hr className="dbl" />
              {payment && (
                <>
                  <div className="total">
                    <span>RECEIVED</span>
                    <span>
                      {payment.amount} <small>{payment.asset.code}</small>
                    </span>
                  </div>
                  <hr />
                </>
              )}
              <div className="c">
                <span className="hl">{complete ? "*** ALL SYSTEMS GO ***" : `*** ${doneCount} OF 4 DONE ***`}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <section className="wh-col" style={{ gap: 16 }}>
        <h2 className="section-title" style={{ fontSize: 24 }}>
          What to do next
        </h2>
        <div className="wz-next">
          <Link href={watch ? `/watches/edit?id=${watch.id}` : "/watches/new"}>
            <span className="ico">
              <Icon name="list-checks" size={20} />
            </span>
            <b>Tighten your rules</b>
            <span>Require a memo, set an amount range, or only accept payments from known senders.</span>
          </Link>
          <Link href="/api-keys">
            <span className="ico">
              <Icon name="key" size={20} />
            </span>
            <b>Create an API key</b>
            <span>Manage watches and read payments from your own code instead of the dashboard.</span>
          </Link>
          <Link href="/events">
            <span className="ico">
              <Icon name="send" size={20} />
            </span>
            <b>See your webhook events</b>
            <span>Every delivery attempt, with status codes, latency and the response your server sent.</span>
          </Link>
        </div>
      </section>
    </SetupFrame>
  );
}
