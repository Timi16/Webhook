"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";
const STORAGE_KEY = "webhook-theme";

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({
  theme: "light",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

/** Wraps every screen in the design's `.app` root and remembers the chosen theme. */
export function AppFrame({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage can be blocked; the default theme is fine
    }
    if (stored === "dark" || stored === "light") setThemeState(stored);
  }, []);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not remembered, still applied
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      <div className="app" data-theme={theme}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
