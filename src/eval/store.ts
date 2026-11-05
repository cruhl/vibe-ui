import { createStore } from "zustand/vanilla";
import type { Point } from "../boxes/index.ts";
import type { EvalReport } from "./report.ts";

/** One simulated-user action as logged and shown. */
export interface ActionLog {
  step: number;
  t: number;
  action: string;
  intent: string;
  intendedElementID: string | null;
  landedElementID: string | null;
  accepted: boolean;
}

export interface EvalState {
  caseName: string;
  mode: string;
  status: "starting" | "running" | "done" | "failed";
  cursor: Point;
  travelMs: number;
  pressed: boolean;
  caption: string | null;
  actions: ActionLog[];
  report: EvalReport | null;
  summary: string | null;
  error: string | null;
}

/** The in-page eval's live state, read by the panel and by the headless driver. */
export const evalStore = createStore<EvalState>(() => ({
  caseName: "",
  mode: "",
  status: "starting",
  cursor: { x: 0.5, y: 0.5 },
  travelMs: 0,
  pressed: false,
  caption: null,
  actions: [],
  report: null,
  summary: null,
  error: null,
}));
