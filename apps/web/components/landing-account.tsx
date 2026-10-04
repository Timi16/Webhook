"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Icon } from "./icons";

/**
 * The landing page's account links: "Log in" and "Start free" for visitors, and a way back into
 * the dashboard for someone who is already logged in.
 */
export function LandingAccount() {
  const [loggedIn, setLoggedIn] = useState(false);
  useEffect(() => {
    api("/auth/me").then(
      () => setLoggedIn(true),
      () => {}, // not logged in, or the API is unreachable: show the visitor links
    );
  }, []);

  if (loggedIn) {
    return (
      <Link className="lpr-btn sm primary" href="/overview">
        Open dashboard
        <Icon name="arrow-right" size={14} />
      </Link>
    );
  }
  return (
    <>
      <Link href="/login">Log in</Link>
      <Link className="lpr-btn sm primary" href="/signup">
        Start free
      </Link>
    </>
  );
}
