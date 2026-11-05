import type { StoreApi } from "zustand/vanilla";
import { record } from "../run-log/index.ts";
import { viewKey, type AppState } from "./state.ts";

const thousandths = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Logs an `overlay` snapshot whenever what is drawn on top of the video changes: the boxes with
 * the state they were found for, the input lock, busy and ready flags, the progress line and the
 * error, so the stage can be rebuilt from the log alone. Returns the stop.
 */
export function logOverlay(store: StoreApi<AppState>): () => void {
  return store.subscribe((next, previous) => {
    if (
      next.boxes === previous.boxes &&
      next.boxesKey === previous.boxesKey &&
      next.locked === previous.locked &&
      next.busy === previous.busy &&
      next.heldReady === previous.heldReady &&
      next.progress === previous.progress &&
      next.error === previous.error &&
      next.shownView === previous.shownView &&
      next.activeSlot === previous.activeSlot &&
      next.phase === previous.phase
    )
      return;
    const labels = new Map(next.shownView.elements.map((element) => [element.id, element.label]));
    record("overlay", {
      phase: next.phase,
      shownKey: viewKey(next.shownView),
      boxesKey: next.boxesKey,
      boxesSource: next.boxesSource,
      boxes: next.boxes.map((found) => ({
        elementID: found.elementID,
        label: labels.get(found.elementID) ?? null,
        top: thousandths(found.box.top),
        bottom: thousandths(found.box.bottom),
        left: thousandths(found.box.left),
        right: thousandths(found.box.right),
        presence: thousandths(found.presence),
      })),
      locked: next.locked,
      busy: next.busy,
      heldReady: next.heldReady,
      progress: next.progress,
      error: next.error,
      activeSlot: next.activeSlot,
    });
  });
}
