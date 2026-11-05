import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { currentRoute } from "../route/index.ts";
import { record } from "../run-log/index.ts";
import { installContentClock } from "./clock.ts";
import { installFetchShim, type ShimOptions } from "./fetch-shim.ts";
import { EvalPanel } from "./panel.tsx";
import { evalOptions, prepareReplay, runEval } from "./runner.ts";
import { evalStore, type EvalState } from "./store.ts";
import type { EvalTarget } from "./target.ts";

export { installKit } from "./kit.ts";
export { buildReport, summarizeReport } from "./report.ts";
export { parseEvalCase } from "./case.ts";
export { type EvalState } from "./store.ts";
export type { EvalTarget } from "./target.ts";

declare global {
  interface Window {
    vibeUIEval?: { getState: () => EvalState };
  }
}

/**
 * Wires eval mode from the URL before the app starts anything: `?jev=mock` alone mocks Jev; with
 * `?eval=<case>` it also installs the content clock (`?speed=`), the fetch shim
 * (`?agent=replay&replay=<fixture>`), the visible cursor, and runs the simulated user
 * (`?user=llm|scripted`) on `target`, the session this page runs. The driver reads
 * `window.vibeUIEval`.
 */
export function installEval(target: EvalTarget): void {
  const route = currentRoute();
  const options = evalOptions(route);
  const shim: ShimOptions = {
    jevMock: route.jev === "mock",
    falMock: options?.omni === "mock",
    replay: null,
  };
  if (options === null) {
    if (shim.jevMock) installFetchShim(shim);
    return;
  }
  const speed = options.omni === "mock" ? options.speed : 1;
  installContentClock({ speed, pauseAllowed: options.omni === "mock" });
  installFetchShim(shim);
  window.vibeUIEval = evalStore;
  const host = document.createElement("div");
  document.body.appendChild(host);
  createRoot(host).render(createElement(EvalPanel, { target }));
  prepareReplay({ ...options, speed }, shim)
    .then((evalCase) => runEval(target, { ...options, speed }, evalCase))
    .catch((error: unknown) => {
      record("eval_failed", { message: String(error) });
      evalStore.setState({ status: "failed", error: String(error) });
    });
}
