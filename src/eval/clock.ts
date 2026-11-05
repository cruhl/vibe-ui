import { record } from "../run-log/index.ts";

interface Timer {
  due: number;
  callback: (...args: unknown[]) => void;
  interval: number | null;
  args: unknown[];
}

const realNow = performance.now.bind(performance);
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
const timers = new Map<number, Timer>();
let nextID = 1_000_000_000;
let anchorReal = realNow();
let anchorContent = anchorReal;
let rate = 1;
let speed = 1;
let pauseAllowed = false;
let thinking = 0;
let realCalls = 0;
let wake: number | null = null;
let installed = false;

function contentNow(): number {
  return anchorContent + (realNow() - anchorReal) * rate;
}

function schedule(): void {
  if (wake !== null) realClearTimeout(wake);
  wake = null;
  if (rate === 0 || timers.size === 0) return;
  let earliest = Number.POSITIVE_INFINITY;
  for (const timer of timers.values()) earliest = Math.min(earliest, timer.due);
  wake = realSetTimeout(fire, Math.max(0, (earliest - contentNow()) / rate));
}

function fire(): void {
  wake = null;
  const now = contentNow();
  const due = [...timers.entries()]
    .filter(([, timer]) => timer.due <= now)
    .sort((first, second) => first[1].due - second[1].due);
  for (const [id, timer] of due) {
    if (!timers.has(id)) continue;
    if (timer.interval === null) timers.delete(id);
    else timer.due = Math.max(timer.due + timer.interval, now);
    timer.callback(...timer.args);
  }
  schedule();
}

function updateRate(): void {
  const next = realCalls > 0 ? 1 : thinking > 0 && pauseAllowed ? 0 : speed;
  if (next === rate) return;
  anchorContent = contentNow();
  anchorReal = realNow();
  rate = next;
  schedule();
}

function add(handler: TimerHandler, delay: unknown, args: unknown[], repeat: boolean): number {
  const id = nextID++;
  const milliseconds = Math.max(0, Number(delay) || 0);
  if (typeof handler === "function")
    timers.set(id, {
      due: contentNow() + milliseconds,
      callback: (...callArgs: unknown[]) => {
        Reflect.apply(handler, window, callArgs);
      },
      interval: repeat ? Math.max(1, milliseconds) : null,
      args,
    });
  schedule();
  return id;
}

function clear(id: unknown): void {
  if (typeof id === "number" && timers.delete(id)) schedule();
  else if (typeof id === "number") realClearTimeout(id);
}

/**
 * Replaces the page's clock with a content clock: `performance.now`, `setTimeout` and
 * `setInterval` run at `speed` times wall time, at wall time while any real network call is in
 * flight (the app's own waits stay exact), and stop while the simulated user is thinking when
 * pausing is allowed (only when nothing outside the page is live). `Date` stays wall time, so a
 * run-log event's `t` is content time and its `at` is wall time.
 */
export function installContentClock(options: { speed: number; pauseAllowed: boolean }): void {
  if (installed) return;
  installed = true;
  speed = options.speed > 0 ? options.speed : 1;
  pauseAllowed = options.pauseAllowed;
  anchorReal = realNow();
  anchorContent = anchorReal;
  rate = speed;
  const define = (target: object, name: string, value: unknown) => {
    Object.defineProperty(target, name, { value, configurable: true, writable: true });
  };
  define(performance, "now", contentNow);
  define(window, "setTimeout", (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    add(handler, delay, args, false),
  );
  define(window, "setInterval", (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    add(handler, delay, args, true),
  );
  define(window, "clearTimeout", clear);
  define(window, "clearInterval", clear);
  record("content_clock", { speed, pauseAllowed });
}

/** Marks a real network call in flight; the clock runs at wall time until the returned end. */
export function beginRealCall(): () => void {
  realCalls++;
  updateRate();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    realCalls--;
    updateRate();
  };
}

/** Stops content time while the simulated user's model decides, when pausing is allowed. */
export async function whileThinking<T>(run: () => Promise<T>): Promise<T> {
  thinking++;
  updateRate();
  try {
    return await run();
  } finally {
    thinking--;
    updateRate();
  }
}

/** How many real network calls are in flight. */
export function realCallsInFlight(): number {
  return realCalls;
}

/** The current content-clock speed, 0 while paused. */
export function clockRate(): number {
  return rate;
}

/** Waits this many content milliseconds. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
