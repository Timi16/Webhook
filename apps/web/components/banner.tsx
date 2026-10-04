import { Icon } from "./icons";

/** Shown on every screen: this service only ever touches testnet. */
export function TestnetBanner() {
  return (
    <div className="wh-testnet" role="note">
      <Icon name="flask" />
      <span className="tag">TESTNET</span>
      <span>Stellar Testnet. No real money.</span>
      <a
        className="hide-sm"
        href="https://lab.stellar.org/account/create?$=network$id=testnet"
        target="_blank"
        rel="noopener"
      >
        Fund a test account
      </a>
    </div>
  );
}
