import { API_URL } from "./api";

/** Names of the Server-Sent Events the API streams to a logged-in developer. */
export type LiveEvent =
  "payment.detected" | "delivery.updated" | "endpoint.updated" | "system.notice";
const NAMES: LiveEvent[] = [
  "payment.detected",
  "delivery.updated",
  "endpoint.updated",
  "system.notice",
];

type Listener = (name: LiveEvent, data: Record<string, unknown>) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<(connected: boolean) => void>();
let source: EventSource | undefined;
let connected = false;

function setConnected(value: boolean) {
  connected = value;
  for (const listener of statusListeners) listener(value);
}

function open() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource(`${API_URL}/v1/stream`, { withCredentials: true });
  source.onopen = () => setConnected(true);
  // The browser reconnects by itself; until then the "Live" indicator shows it is not live.
  source.onerror = () => setConnected(false);
  for (const name of NAMES) {
    source.addEventListener(name, (event) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>;
      } catch {
        // an event without a readable body still means "something changed"
      }
      for (const listener of listeners) listener(name, data);
    });
  }
}

function closeIfUnused() {
  if (listeners.size > 0 || statusListeners.size > 0) return;
  source?.close();
  source = undefined;
  connected = false;
}

/** One shared stream for the whole app, opened on first use and closed when nobody listens. */
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  open();
  return () => {
    listeners.delete(listener);
    closeIfUnused();
  };
}

export function subscribeLiveStatus(listener: (connected: boolean) => void): () => void {
  statusListeners.add(listener);
  open();
  listener(connected);
  return () => {
    statusListeners.delete(listener);
    closeIfUnused();
  };
}
