"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

type Tone = "ok" | "bad" | "neutral";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
  /** Where "View" takes you, for toasts about something that has its own page. */
  href?: string | undefined;
}

const ICONS: Record<Tone, IconName> = { ok: "check-circle", bad: "alert-circle", neutral: "info" };
const VISIBLE_MS = 4_000;
const MAX_VISIBLE = 4;

const ToastContext = createContext<
  (message: string, options?: { tone?: Tone; href?: string }) => void
>(() => {});

/** Shows a short confirmation in the corner of the screen: "Copied", "Payment verified". */
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback(
    (id: number) => setToasts((all) => all.filter((t) => t.id !== id)),
    [],
  );
  const show = useCallback(
    (message: string, options: { tone?: Tone; href?: string } = {}) => {
      const id = nextId.current++;
      setToasts((all) => [
        ...all.slice(-(MAX_VISIBLE - 1)),
        { id, message, tone: options.tone ?? "ok", href: options.href },
      ]);
      setTimeout(() => dismiss(id), VISIBLE_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Announced politely: a toast confirms something, it never interrupts. */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast is-${toast.tone}`} key={toast.id}>
            <Icon name={ICONS[toast.tone]} />
            <span>{toast.message}</span>
            {toast.href && (
              <Link href={toast.href} onClick={() => dismiss(toast.id)}>
                View
              </Link>
            )}
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
