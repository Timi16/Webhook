"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeChoice = "system" | "light" | "dark";
type Theme = "light" | "dark";
const STORAGE_KEY = "webhook-theme";

const ThemeContext = createContext<{ choice: ThemeChoice; setChoice: (choice: ThemeChoice) => void }>({
  choice: "system",
  setChoice: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

/** Wraps every screen in the design's `.app` root and remembers the chosen theme. */
export function AppFrame({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>("system");
  const [system, setSystem] = useState<Theme>("light");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage can be blocked; following the system is fine
    }
    if (stored === "dark" || stored === "light" || stored === "system") setChoiceState(stored);

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystem(query.matches ? "dark" : "light");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const setChoice = (next: ThemeChoice) => {
    setChoiceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not remembered, still applied
    }
  };

  return (
    <ThemeContext.Provider value={{ choice, setChoice }}>
      <div className="app" data-theme={choice === "system" ? system : choice}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
