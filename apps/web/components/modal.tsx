"use client";

import { useEffect, useId, type ReactNode } from "react";

/** A centred dialog over a scrim. Escape closes it. */
export function Modal({
  title,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay">
      <div
        className={wide ? "wh-modal is-wide" : "wh-modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
        </header>
        <div className="content">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  );
}
