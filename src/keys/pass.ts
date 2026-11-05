import { z } from "zod";
import { record } from "../run-log/index.ts";

interface TurnstileOptions {
  sitekey: string;
  action: string;
  "refresh-expired": "auto";
  callback: (token: string) => void;
  "error-callback": (code: string) => boolean;
}

interface Turnstile {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widgetID: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const scriptURL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const action = "hosted";
const renewBeforeMs = 3 * 60_000;
const passDeadlineMs = 20_000;

const Issued = z.object({ expiresAt: z.number() });

let siteKey: string | null = null;
let widgetID: string | null = null;
let expiresAt = 0;
let pending: Promise<boolean> | null = null;
let settle: ((passed: boolean) => void) | null = null;
let renewal: ReturnType<typeof setTimeout> | null = null;

function finish(passed: boolean): void {
  settle?.(passed);
  settle = null;
  pending = null;
}

async function redeem(token: string): Promise<void> {
  const response = await fetch("/api/pass", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null);
  const issued = Issued.safeParse(response?.ok === true ? await response.json() : null);
  if (!issued.success) {
    record("pass_refused", { status: response?.status ?? null });
    finish(false);
    return;
  }
  expiresAt = issued.data.expiresAt;
  if (renewal !== null) clearTimeout(renewal);
  renewal = setTimeout(
    () => void ensurePass(),
    Math.max(0, expiresAt - renewBeforeMs - Date.now()),
  );
  finish(true);
}

function loadScript(): Promise<Turnstile | null> {
  if (window.turnstile !== undefined) return Promise.resolve(window.turnstile);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = scriptURL;
    script.addEventListener("load", () => {
      resolve(window.turnstile ?? null);
    });
    script.addEventListener("error", () => {
      resolve(null);
    });
    document.head.append(script);
  });
}

async function challenge(key: string): Promise<void> {
  const turnstile = await loadScript();
  if (turnstile === null) {
    record("pass_refused", { status: "script" });
    finish(false);
    return;
  }
  if (widgetID !== null) {
    turnstile.reset(widgetID);
    return;
  }
  const container = document.createElement("div");
  container.dataset.pass = "";
  document.body.append(container);
  widgetID =
    turnstile.render(container, {
      sitekey: key,
      action,
      "refresh-expired": "auto",
      callback: (token) => void redeem(token),
      "error-callback": (code) => {
        record("pass_refused", { status: code });
        finish(false);
        return true;
      },
    }) ?? null;
}

/**
 * Makes sure this browser holds a fresh hosted-play pass, earning one with an invisible
 * Turnstile challenge when it has none or it is within three minutes of expiring. Answers
 * whether a pass is held; false without a site key, or when the challenge fails or takes over
 * 20 s, so a hosted call then fails on its own 403 instead of waiting forever.
 */
export function ensurePass(): Promise<boolean> {
  if (siteKey === null) return Promise.resolve(false);
  if (Date.now() < expiresAt - renewBeforeMs) return Promise.resolve(true);
  if (pending !== null) return pending;
  const key = siteKey;
  pending = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const waiting = pending;
  setTimeout(() => {
    if (pending === waiting) finish(false);
  }, passDeadlineMs);
  void challenge(key);
  return waiting;
}

/** Sets the Turnstile site key `/api/config` gave; no challenge runs until a pass is wanted. */
export function setPassKey(key: string | null): void {
  siteKey = key;
}

/**
 * `fetch` for this site's hosted routes: waits for a fresh pass first, and when the Worker still
 * answers that one is required (expired, or the visitor's network changed), earns a new pass and
 * sends the request once more.
 */
export async function hostedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  await ensurePass();
  const response = await window.fetch(input, init);
  if (response.status !== 403 || response.headers.get("X-Pass") !== "required") return response;
  await response.body?.cancel();
  expiresAt = 0;
  await ensurePass();
  return window.fetch(input, init);
}
