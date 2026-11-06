import { failureKinds } from "./failures.ts";
import type { RunEvent } from "./log.ts";
import { redact } from "./redact.ts";

const endpoint = "/api/log";
const flushMs = 2000;
const maxBatchEvents = 250;
const maxBatchCharacters = 384 * 1024;
const maxPendingEvents = 2000;
const maxFieldCharacters = 2000;
const maxSessionCharacters = 24 * 1024 * 1024;
const keepaliveBytes = 60_000;
const backoffMs = 60_000;

const secrets = new Set<string>();
let pending: string[] = [];
let pendingFailures = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let sequence = 0;
let sentCharacters = 0;
let pausedUntil = 0;
let capped = false;
let sending = false;
let listening = false;
let session = "";

/** Remembers a key this page holds, so the sink never sends it, whatever event carries it. */
export function rememberSecret(value: string): void {
  if (value.length >= 8) secrets.add(value);
}

function shorten(_key: string, value: unknown): unknown {
  if (typeof value !== "string" || value.length <= maxFieldCharacters) return value;
  if (value.startsWith("data:"))
    return `[${value.slice(0, value.indexOf(",") + 1)} ${String(value.length)} chars]`;
  return `${value.slice(0, maxFieldCharacters)}...[${String(value.length)} chars]`;
}

function line(event: RunEvent): string {
  return redact(JSON.stringify(event, shorten), [...secrets]);
}

async function encode(
  text: string,
  keepalive: boolean,
): Promise<{ body: BodyInit; type: string; bytes: number }> {
  if (typeof CompressionStream === "undefined" || (keepalive && text.length < keepaliveBytes))
    return { body: text, type: "application/json", bytes: text.length };
  const compressed = await new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return { body: compressed, type: "application/gzip", bytes: compressed.byteLength };
}

function take(): { lines: string[]; failed: string[] } {
  const lines: string[] = [];
  let characters = 0;
  while (pending.length > 0 && lines.length < maxBatchEvents) {
    const next = pending[0] ?? "";
    if (lines.length > 0 && characters + next.length > maxBatchCharacters) break;
    lines.push(next);
    characters += next.length;
    pending.shift();
  }
  const failed = [...pendingFailures];
  pendingFailures = new Set();
  return { lines, failed };
}

function requeue(lines: readonly string[], failed: readonly string[]): void {
  pending = [...lines, ...pending].slice(-maxPendingEvents);
  for (const kind of failed) pendingFailures.add(kind);
}

async function send(keepalive: boolean): Promise<void> {
  if ((sending && !keepalive) || capped || pending.length === 0 || Date.now() < pausedUntil) return;
  sending = true;
  const { lines, failed } = take();
  const text = `{"session":${JSON.stringify(session)},"sequence":${String(sequence)},"failed":${JSON.stringify(failed)},"events":[${lines.join(",")}]}`;
  sequence++;
  sentCharacters += text.length;
  try {
    const { body, type, bytes } = await encode(text, keepalive);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": type, "X-Vibe-Session": session },
      body,
      keepalive: keepalive && bytes < keepaliveBytes,
    });
    if (response.status === 429 || response.status >= 500) {
      pausedUntil = Date.now() + backoffMs;
      requeue(lines, failed);
    }
  } catch {
    requeue(lines, failed);
  } finally {
    sending = false;
  }
  if (sentCharacters > maxSessionCharacters) {
    capped = true;
    pending = [];
  }
  if (pending.length > 0) schedule();
}

function schedule(): void {
  timer ??= setTimeout(
    () => {
      timer = null;
      void send(false);
    },
    Math.max(flushMs, pausedUntil - Date.now()),
  );
}

function listen(): void {
  if (listening) return;
  listening = true;
  addEventListener("pagehide", () => {
    flushSink();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSink();
  });
}

/**
 * Queues one run-log event for the deployment's `/api/log`: shortened (long strings cut, data
 * URLs reduced to their size), stripped of every remembered key and anything key-shaped, and sent
 * in gzip batches of at most 250 events every two seconds under a session id. A 429 or a server
 * failure backs off a minute and keeps the batch; a session stops sending past 24 MB.
 */
export function sinkEvent(sessionID: string, event: RunEvent): void {
  if (capped) return;
  session = sessionID;
  listen();
  pending.push(line(event));
  if (failureKinds.has(event.kind)) pendingFailures.add(event.kind);
  if (pending.length > maxPendingEvents) pending = pending.slice(-maxPendingEvents);
  if (pending.length >= maxBatchEvents) void send(false);
  else schedule();
}

/** Sends what the sink holds now, as a keepalive request when it is small enough. */
export function flushSink(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  void send(true);
}
