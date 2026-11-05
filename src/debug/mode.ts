import { useEffect, useSyncExternalStore } from "react";
import { currentRoute } from "../route/index.ts";

const listeners = new Set<() => void>();
let enabled = currentRoute().debug;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const setEnabled = (value: boolean) => {
  enabled = value;
  for (const listener of listeners) listener();
};

/** True while debug mode is on: from `?debug=1` at load, flipped by the backtick key. */
export function useDebugMode(): boolean {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "`") return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      setEnabled(!enabled);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => enabled,
  );
}
