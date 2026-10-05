"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useApi } from "@/lib/hooks";
import type { Developer } from "@/lib/types";
import { ErrorAlert } from "./ui";

const SessionContext = createContext<{ developer: Developer; reload: () => void } | null>(null);

/** The logged-in developer. Only usable inside the app shell. */
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionGate");
  return session;
}

/** Shows its children only to a logged-in developer; anyone else is sent to the login page. */
export function SessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data, error, reload } = useApi<{ developer: Developer }>("/auth/me");
  const loggedOut = error?.status === 401;

  // An account is locked until the code emailed at signup has been entered.
  const unverified = data?.developer.emailVerified === false;
  useEffect(() => {
    if (loggedOut) router.replace("/login");
    else if (unverified) router.replace("/verify-email");
  }, [loggedOut, unverified, router]);

  if (error && !loggedOut) {
    return (
      <div className="auth">
        <div className="auth-card">
          <ErrorAlert error={error} title="Couldn't load your account." onRetry={reload} />
        </div>
      </div>
    );
  }
  if (!data || unverified) return <div className="auth" aria-busy="true" />;
  return (
    <SessionContext.Provider value={{ developer: data.developer, reload }}>
      {children}
    </SessionContext.Provider>
  );
}
