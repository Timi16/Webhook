import Link from 'next/link';

const steps = [
  { title: 'Watch a wallet', body: 'Register a Stellar Testnet address with the asset, amount, memo and sender you expect.' },
  { title: 'Someone pays it', body: 'The payment is picked up within seconds of the ledger closing and checked against your rules.' },
  { title: 'Your app is told', body: 'A signed webhook is delivered to your endpoint and retried for up to two days until it succeeds.' },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-12 px-6 py-16">
      <div className="flex flex-col gap-5">
        <p className="text-sm font-medium text-fd-muted-foreground">Stellar Testnet</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Know the moment your wallet is paid.
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground">
          Webhook watches Stellar wallets, verifies each incoming payment against your conditions and
          delivers a signed event to your server. It never holds a secret key or moves funds.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/docs/quickstart"
            className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
          >
            Quickstart
          </Link>
          <Link href="/api-reference" className="rounded-lg border px-4 py-2 text-sm font-medium">
            API reference
          </Link>
        </div>
      </div>
      <ol className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="rounded-xl border bg-fd-card p-5">
            <p className="font-mono text-xs text-fd-muted-foreground">0{index + 1}</p>
            <h2 className="mt-2 font-medium">{step.title}</h2>
            <p className="mt-1 text-sm text-fd-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
