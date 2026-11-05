export type RunEventPayload = Record<string, unknown>;

export interface RunEvent extends RunEventPayload {
  kind: string;
  t: number;
  at: string;
}

type Listener = (events: readonly RunEvent[]) => void;

const startedAt = performance.now();
const keepaliveLimit = 60_000;
const runID = new Date().toISOString().replace(/[:.]/g, "-");
const events: RunEvent[] = [];
const listeners = new Set<Listener>();
let pending: RunEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Seconds on the one session clock, measured from page load. */
export function now(): number {
  return Math.round(performance.now() - startedAt) / 1000;
}

/** Seconds on the session clock of a DOM event's timestamp. */
export function eventSeconds(timeStamp: number): number {
  return Math.max(0, now() - Math.max(0, performance.now() - timeStamp) / 1000);
}

/** The identifier of this run, also the JSONL file name in dev. */
export function getRunID(): string {
  return runID;
}

function flush(): void {
  flushTimer = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const body = JSON.stringify({ runID, events: batch });
  void fetch("/__dev/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: body.length < keepaliveLimit,
  }).catch(() => {
    pending = [...batch, ...pending];
  });
}

/** Stamps an event on the session clock, keeps it in memory, and in dev streams it to disk. */
export function record(kind: string, payload: RunEventPayload = {}): RunEvent {
  const event: RunEvent = { ...payload, kind, t: now(), at: new Date().toISOString() };
  events.push(event);
  for (const listener of listeners) listener(events);
  if (import.meta.env.DEV) {
    pending.push(event);
    flushTimer ??= setTimeout(flush, 300);
  }
  return event;
}

/** Sends any batched events now; used before the page unloads. */
export function flushNow(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  if (import.meta.env.DEV) flush();
}

/** Every event recorded so far, oldest first. */
export function getEvents(): readonly RunEvent[] {
  return events;
}

/** Calls the listener with all events after each new one; returns the unsubscribe. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
