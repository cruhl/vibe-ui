import { record } from "./log.ts";

let installed = false;

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Copies browser console errors and warnings, uncaught errors and unhandled promise rejections
 * into the run log as `console` events, keeping the console's own output. Installed once.
 */
export function captureConsole(): void {
  if (installed) return;
  installed = true;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record("console", { level, message: args.map(describe).join(" ").slice(0, 2000) });
      original(...args);
    };
  }
  window.addEventListener("error", (event) => {
    record("console", {
      level: "uncaught",
      message: describe(event.error ?? event.message).slice(0, 2000),
      source: `${event.filename}:${event.lineno}:${event.colno}`,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    record("console", {
      level: "unhandled_rejection",
      message: describe(event.reason).slice(0, 2000),
    });
  });
}
