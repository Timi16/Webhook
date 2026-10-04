import { trustFor, type Account } from "@/lib/accounts";
import { Icon } from "./icons";

/** Whether the watched wallet can actually receive the watch's assets. */
export function TrustStatus({
  account,
  assets,
  compact,
}: {
  account: Account | undefined;
  assets: { code: string; issuer: string | null }[];
  compact?: boolean;
}) {
  const { state, missing } = trustFor(account, assets);
  const style = compact ? { fontSize: 12 } : undefined;
  const size = compact ? 14 : 16;
  switch (state) {
    case "ok":
      return (
        <span className="wh-help is-ok" style={style}>
          <Icon name="shield" size={size} />
          {compact
            ? "ok"
            : assets
                .map((a) => (a.issuer === null ? `${a.code} native` : `${a.code} ok`))
                .join(" · ")}
        </span>
      );
    case "missing":
      return (
        <span className="wh-help is-warn" style={style}>
          <Icon name="alert-triangle" size={size} />
          {compact
            ? "missing"
            : `No ${missing.join(", ")} trustline. Those payments will fail until the wallet adds one.`}
        </span>
      );
    case "no-account":
      return (
        <span className="wh-help is-warn" style={style}>
          <Icon name="alert-triangle" size={size} />
          {compact
            ? "no account"
            : "This account doesn't exist on testnet yet. Fund it to activate it."}
        </span>
      );
    default:
      return <span className="muted">{account ? "unknown" : "…"}</span>;
  }
}
