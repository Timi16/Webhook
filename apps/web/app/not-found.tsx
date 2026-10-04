import Link from "next/link";
import { Icon } from "@/components/icons";
import { SystemPage } from "@/components/system";

export default function NotFound() {
  return (
    <SystemPage code="404 · not found" title="That page isn't here">
      <p className="hint" style={{ fontSize: 14 }}>
        The link may be old, or the ID may belong to another account. Open the item from its list
        instead.
      </p>
      <div className="wh-row">
        <Link className="wh-btn is-primary" href="/overview">
          <Icon name="arrow-left" />
          Go to overview
        </Link>
        <Link className="wh-btn" href="/payments">
          <Icon name="search" />
          Search payments
        </Link>
      </div>
    </SystemPage>
  );
}
