import Link from "next/link";
import { Icon, Logo, type IconName } from "@/components/icons";
import { LandingMotion } from "@/components/landing-motion";
import { DOCS_URL } from "@/lib/constants";

// Everything in the previews below is example data, labelled as such for screen readers.
const ROLL = [
  ["14:02:11", "Shop till", "250.0000000 USDC", "ok", "delivered"],
  ["14:02:18", "Invoices", "1500.0000000 USDC", "ok", "delivered"],
  ["14:02:25", "Shop till", "12.0000000 USDC", "bad", "rejected"],
  ["14:02:31", "Donations", "25.5000000 XLM", "warn", "retrying"],
  ["14:02:40", "Shop till", "95.0000000 USDC", "ok", "delivered"],
  ["14:02:47", "Invoices", "480.2500000 USDC", "ok", "delivered"],
  ["14:02:53", "Shop till", "60.0000000 USDC", "ok", "delivered"],
  ["14:03:02", "Donations", "1200.0000000 XLM", "ok", "delivered"],
] as const;

// [verified, rejected] per hour for the dashboard preview.
const HOURS: [number, number][] = [
  [108, 5],
  [104, 5],
  [89, 5],
  [71, 3],
  [58, 2],
  [44, 2],
  [33, 1],
  [22, 1],
  [15, 1],
  [7, 1],
  [4, 0],
  [3, 0],
  [2, 0],
  [2, 1],
  [3, 1],
  [9, 0],
  [24, 2],
  [53, 3],
  [80, 4],
  [97, 4],
  [106, 4],
  [102, 3],
  [93, 4],
  [100, 3],
];
const PEAK = Math.max(...HOURS.map(([verified, rejected]) => verified + rejected));

const NAV: { label: string; icon: IconName }[] = [
  { label: "Overview", icon: "layout" },
  { label: "Watches", icon: "eye" },
  { label: "Endpoints", icon: "webhook" },
  { label: "Payments", icon: "arrow-down-left" },
  { label: "Webhook events", icon: "send" },
  { label: "API keys", icon: "key" },
  { label: "Settings", icon: "settings" },
];

const STATS = [
  ["Payments detected · 24h", "1284", "+12% vs yesterday"],
  ["Verified / rejected", "1231 / 53", "95.9% verified"],
  ["Webhook success", "98.4%", "21 retried · 2 failed"],
  ["Median delivery", "412 ms", "p95 1.9 s"],
] as const;

export default function LandingPage() {
  return (
    <div className="lpr mix">
      <LandingMotion />
      <div className="lpr-banner" role="note">
        <Icon name="flask" size={14} />
        Stellar Testnet. No real money.
      </div>
      <header className="lpr-nav-wrap">
        <div className="lpr-nav">
          <Link className="brand" href="/" aria-label="Webhook home">
            <Logo />
            <span className="wordmark">webhook</span>
          </Link>
          <nav className="lpr-links" aria-label="Site">
            <a className="hide-sm" href="#how">
              How it works
            </a>
            <a className="hide-sm" href="#dashboard">
              Dashboard
            </a>
            <a className="hide-sm" href="#features">
              Features
            </a>
            <a className="hide-sm" href={DOCS_URL}>
              Docs
            </a>
            <Link href="/login">Log in</Link>
            <Link className="lpr-btn sm primary" href="/signup">
              Start free
            </Link>
          </nav>
        </div>
        <span className="lpr-progress" aria-hidden="true" />
      </header>
      <div className="lpr-wrap">
        <section className="lpr-hero">
          <div>
            <span className="lpr-eyebrow" data-in="">
              <span className="dot" aria-hidden="true" />
              Live on Stellar Testnet
            </span>
            <h1 data-in="">
              Know the moment a Stellar payment <mark>lands.</mark>
            </h1>
            <p className="lede" data-in="">
              Webhook watches your wallets, checks every payment against your rules, and POSTs a
              signed event to your server seconds after the ledger closes. Server down? We keep
              retrying for two days.
            </p>
            <div className="ctas" data-in="">
              <Link className="lpr-btn primary" href="/signup">
                Start free on testnet
                <Icon name="arrow-right" />
              </Link>
              <a className="lpr-btn" href="#how">
                See how it works
              </a>
            </div>
            <p className="fine" data-in="">
              No card · No node to run · First webhook in about five minutes
            </p>
          </div>
          <div className="rc-wrap">
            <div
              className="rc"
              aria-label="Example: a printed receipt for one verified and delivered payment"
            >
              <div className="c">
                <b>WEBHOOK</b>
                <br />
                Payment receipt · #000412
                <br />
                Stellar Testnet
              </div>
              <hr />
              {[
                ["LEDGER", "1204331"],
                ["TIME", "14:02:11 UTC"],
                ["FROM", "GCQJ…QH3S"],
                ["TO", "Shop till"],
                ["MEMO", "INV-0412"],
              ].map(([key, value]) => (
                <div className="r" key={key}>
                  <span>{key}</span>
                  <span>{value}</span>
                </div>
              ))}
              <hr />
              {["ASSET USDC", "AMOUNT ≥ 50", "MEMO MATCH"].map((rule) => (
                <div className="r" key={rule}>
                  <span>{rule}</span>
                  <span className="pass">PASS</span>
                </div>
              ))}
              <hr className="dbl" />
              <div className="total">
                <span>TOTAL</span>
                <span>
                  250.0000000 <small>USDC</small>
                </span>
              </div>
              <hr />
              <div className="del">
                <span>*** DELIVERED 200 OK · 312 MS ***</span>
              </div>
              <div className="c" style={{ marginTop: 10, fontSize: 11 }}>
                POST api.shopkit.ng/hooks/stellar
              </div>
            </div>
          </div>
        </section>
        <div className="lpr-strip" data-reveal="">
          <div>
            <span className="v">7 decimals</span>
            <span className="k">Exact amount strings, never rounded.</span>
          </div>
          <div>
            <span className="v">Signed</span>
            <span className="k">HMAC-SHA256 on every request.</span>
          </div>
          <div>
            <span className="v">10 attempts</span>
            <span className="k">Backoff over two days, then replay with one click.</span>
          </div>
          <div>
            <span className="v">Free</span>
            <span className="k">On testnet while you build.</span>
          </div>
        </div>

        <section className="lpr-sec" id="how">
          <span className="eb" data-reveal="">
            How it works
          </span>
          <h2 data-reveal="">Three steps. No indexer to host, no polling loop to babysit.</h2>
          <div className="lpr-how" data-reveal="">
            <div>
              <span className="n">01 · WATCH</span>
              <h3>Add a wallet</h3>
              <p>
                Paste a public G… address. We confirm its trustlines and start reading every ledger
                for payments to it.
              </p>
            </div>
            <div>
              <span className="n">02 · VERIFY</span>
              <h3>Set the rules</h3>
              <p>
                Asset, exact or ranged amount, memo, allowed senders. A payment that misses is
                rejected with a reason code, so you always know why.
              </p>
            </div>
            <div>
              <span className="n">03 · DELIVER</span>
              <h3>Get a signed webhook</h3>
              <p>
                Verified or rejected, your server hears about it seconds after the ledger closes. If
                it doesn't answer 2xx, we keep trying for two days.
              </p>
            </div>
          </div>
          <div className="lpr-roll" data-reveal="" aria-label="Example: payments printing live">
            <div className="h">
              <span>Time</span>
              <span className="hide-sm">Watch</span>
              <span>Amount</span>
              <span>Status</span>
            </div>
            <div className="tr">
              {[...ROLL, ...ROLL].map(([time, watch, amount, tone, status], i) => (
                <div className="row" key={i} aria-hidden={i >= ROLL.length}>
                  <span className="m">{time}</span>
                  <span className="hide-sm">{watch}</span>
                  <span>{amount}</span>
                  <span className={`st ${tone}`}>{status}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lpr-sec" id="dashboard">
          <span className="eb" data-reveal="">
            The dashboard
          </span>
          <h2 data-reveal="">Every payment, rule and retry in one place.</h2>
          <p className="sl" data-reveal="">
            Watch payments land live, see exactly why one was rejected, and replay anything your
            server missed.
          </p>
          <div
            className="lpr-dash"
            data-reveal=""
            aria-label="Preview of the Webhook dashboard, with example data"
          >
            <div className="chrome">
              <i />
              <i />
              <i />
              <span>webhook · overview</span>
            </div>
            <div className="app" data-theme="light">
              <div className="shell">
                <div className="nav" aria-hidden="true">
                  <span className="brand">
                    <Logo />
                    <span className="wordmark">webhook</span>
                    <span className="net">testnet</span>
                  </span>
                  <ul className="nav-list">
                    {NAV.map((item, i) => (
                      <li key={item.label}>
                        <span className={i === 0 ? "nav-item is-active" : "nav-item"}>
                          <Icon name={item.icon} />
                          <span>{item.label}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="nav-foot">
                    <span className="avatar">TA</span>
                    <span className="who">
                      <span>Tolu Adebayo</span>
                      <span className="muted">Shopkit</span>
                    </span>
                  </div>
                </div>
                <div className="main">
                  <header className="page-head">
                    <div className="ph-row">
                      <div className="ph-text">
                        <p
                          className="display"
                          style={{
                            margin: 0,
                            font: '800 30px/1.1 "Bricolage Grotesque", sans-serif',
                            letterSpacing: "-0.03em",
                          }}
                        >
                          Overview
                        </p>
                        <p className="sub">Last 24 hours · Stellar Testnet</p>
                      </div>
                      <div className="wh-row">
                        <span className="wh-btn">
                          <Icon name="send" />
                          Send test webhook
                        </span>
                        <span className="wh-btn is-primary">
                          <Icon name="plus" />
                          Create watch
                        </span>
                      </div>
                    </div>
                  </header>
                  <div className="wh-stats">
                    {STATS.map(([label, value, sub]) => (
                      <div className="wh-stat" key={label}>
                        <div className="lbl">{label}</div>
                        <div className="val">{value}</div>
                        <div className="sub">{sub}</div>
                      </div>
                    ))}
                  </div>
                  <section className="wh-panel">
                    <header>
                      <span className="h">Payments per hour</span>
                      <span className="legend">
                        <span>
                          <i style={{ background: "var(--ok)" }} />
                          verified
                        </span>
                        <span>
                          <i style={{ background: "var(--bad)" }} />
                          rejected
                        </span>
                        <span>
                          <i style={{ background: "var(--signal)" }} />
                          this hour
                        </span>
                      </span>
                    </header>
                    <div
                      className="chart"
                      role="img"
                      aria-label="Example chart: payments per hour over 24 hours, mostly verified."
                    >
                      <div className="bars">
                        {HOURS.map(([verified, rejected], i) => (
                          <div
                            className={i === HOURS.length - 1 ? "bar is-now" : "bar"}
                            key={i}
                            style={{
                              height: Math.max(4, Math.round(((verified + rejected) / PEAK) * 128)),
                              animationDelay: `${i * 25}ms`,
                            }}
                          >
                            <span className="ok" style={{ flex: `${verified} 1 0` }} />
                            <span className="bad" style={{ flex: `${rejected} 1 0` }} />
                          </div>
                        ))}
                      </div>
                      <div className="axis">
                        <span>15:00 yesterday</span>
                        <span>21:00</span>
                        <span>03:00</span>
                        <span>09:00</span>
                        <span>now</span>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="lpr-sec" id="features">
          <span className="eb" data-reveal="">
            Built for money
          </span>
          <h2 data-reveal="">The tedious parts of taking payments, handled.</h2>
          <div className="lpr-feat">
            <div className="card" data-reveal="">
              <h3>
                <Icon name="list-checks" size={20} />
                Rules, not regex
              </h3>
              <p>
                Exact, min, max or range on the amount. Memo equals, present or absent. A sender
                allowlist when you need one. Every payment shows which rule passed and which failed.
              </p>
              <div className="tags">
                <span className="t-ok">pass</span>
                <span className="t-bad">fail</span>
                <span className="t-code">AMOUNT_BELOW_MIN</span>
              </div>
            </div>
            <div className="card" data-reveal="">
              <h3>
                <Icon name="rotate" size={20} />
                Retries you can see
              </h3>
              <p>
                Every attempt is logged with its status code, latency and the first 1 KB of your
                response. Missed a deploy? Replay every failed event since any time.
              </p>
              <div className="tags">
                <span className="t-bad">failed</span>
                <span className="t-warn">retrying</span>
                <span className="t-ok">delivered</span>
              </div>
            </div>
            <div className="card" data-reveal="">
              <h3>
                <Icon name="shield-check" size={20} />
                Secrets stay secret
              </h3>
              <p>
                Signing secrets and API keys are shown once. Rotating keeps the old secret valid for
                24 hours, so you deploy without dropping events. Paste an S… secret key by mistake
                and we refuse it.
              </p>
            </div>
            <div className="card" data-reveal="">
              <h3>
                <Icon name="wifi" size={20} />
                Made for real-world networks
              </h3>
              <p>
                The dashboard is light, works on a 360 px phone and holds its place on a slow
                connection. If the network lags, we catch up ledger by ledger. Nothing is skipped.
              </p>
            </div>
          </div>
        </section>

        <section className="lpr-sec" id="developers">
          <div className="lpr-split">
            <div data-reveal="">
              <span className="eb">For developers</span>
              <h2>Verify one header. Ship the feature.</h2>
              <p className="sl">
                One shared secret, one HMAC, one comparison. The payload carries the payment exactly
                as it landed on the ledger, tx hash included, so you can check it yourself.
              </p>
              <div className="ctas">
                <Link className="lpr-btn primary" href="/signup">
                  Get an API key
                </Link>
                <a className="lpr-btn" href={DOCS_URL}>
                  <Icon name="book" />
                  Read the docs
                </a>
              </div>
            </div>
            <pre
              className="lpr-code"
              data-reveal=""
              tabIndex={0}
              aria-label="Example: verifying a webhook signature in Express"
            >
              <span className="c">
                {"// Express: verify the signature, then trust the payload\n"}
              </span>
              <span className="k">const</span>
              {' raw = express.raw({ type: "application/json" });\n\n'}
              <span className="k">app</span>
              {'.post("/hooks/stellar", raw, (req, res) => {\n  '}
              <span className="k">const</span>
              {' t = req.get("Webhook-Timestamp");\n  '}
              <span className="k">const</span>
              {" expected = crypto\n"}
              {'    .createHmac("sha256", process.env.WEBHOOK_SECRET)\n'}
              {'    .update(t + "." + req.body)\n'}
              {'    .digest("hex");\n  '}
              <span className="k">const</span>
              {' sent = req.get("Webhook-Signature"); '}
              <span className="c">{"// v1=<hex>\n  "}</span>
              <span className="k">if</span>
              {" (!matches(sent, expected)) {\n    "}
              <span className="k">return</span>
              {" res.sendStatus(400);\n  }\n  "}
              <span className="k">const</span>
              {" { type, data } = JSON.parse(req.body);\n  "}
              <span className="k">if</span>
              {' (type === "payment.received") {\n'}
              {"    markInvoicePaid(data.payment.memo, data.payment.amount);\n  }\n"}
              {"  res.sendStatus(200); "}
              <span className="c">{"// anything else and we retry\n"}</span>
              {"});\n"}
              <span className="c">
                {"// matches(): a constant-time compare. Full version in the docs."}
              </span>
            </pre>
          </div>
        </section>

        <section className="lpr-cta" data-reveal="">
          <div>
            <h2>Ship your first payment webhook today.</h2>
            <p>Free on testnet. All you need is a wallet address and a URL that returns 200.</p>
          </div>
          <Link className="lpr-btn primary" href="/signup">
            Start free on testnet
            <Icon name="arrow-right" />
          </Link>
        </section>
      </div>
      <footer className="lpr-foot">
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
          <Logo />
          <span>webhook · payment webhooks for Stellar</span>
        </span>
        <span>Testnet only. No real money moves.</span>
      </footer>
    </div>
  );
}
