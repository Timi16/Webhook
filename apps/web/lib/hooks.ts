"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { subscribeLive, subscribeLiveStatus, type LiveEvent } from "./live";

export interface Query<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True until the first answer arrives. Later refreshes keep showing the data they replace. */
  loading: boolean;
  reload: () => void;
}

/**
 * Loads `path` and keeps it fresh: it reloads when one of `refreshOn` arrives on the live
 * stream. Pass null to wait (for example until an ID is known).
 */
export function useApi<T>(path: string | null, refreshOn: LiveEvent[] = []): Query<T> {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: ApiError }>({ path });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal }).then(
      (data) => setState({ path, data }),
      (error: unknown) => {
        if (error instanceof ApiError)
          setState((previous) => ({
            path,
            data: previous.path === path ? previous.data : undefined,
            error,
          }));
      },
    );
    return () => controller.abort();
  }, [path, version]);

  const events = refreshOn.join(",");
  useEffect(() => {
    if (!events) return;
    const wanted = new Set(events.split(","));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeLive((name) => {
      if (!wanted.has(name)) return;
      // A burst of events becomes one reload.
      clearTimeout(timer);
      timer = setTimeout(reload, 250);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [events, reload]);

  const current = state.path === path ? state : { path };
  return {
    data: current.data,
    error: current.error,
    loading: path !== null && current.data === undefined && current.error === undefined,
    reload,
  };
}

/** Whether the live stream is connected right now. */
export function useLiveStatus(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => subscribeLiveStatus(setConnected), []);
  return connected;
}

/** Runs an action (a form submit, a button) and tracks its pending and error state. */
export function useAction<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const latest = useRef(action);
  latest.current = action;

  const run = useCallback(async (...args: Args): Promise<Result | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await latest.current(...args);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, "INTERNAL", "Something went wrong. Try again."),
      );
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { run, pending, error, clearError: () => setError(undefined) };
}
