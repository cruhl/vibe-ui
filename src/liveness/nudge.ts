import { createStore } from "zustand/vanilla";

/** How many times the busy state was nudged; the busy view shakes once on every change. */
export const nudgeStore = createStore<{ count: number }>(() => ({ count: 0 }));

/** Shakes the busy state once: the visible answer to a press while input is locked. */
export function nudgeBusy(): void {
  nudgeStore.setState((state) => ({ count: state.count + 1 }));
}
