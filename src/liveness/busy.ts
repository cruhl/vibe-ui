import { artURL, currentScenarioID, getScenario, type BusyKit } from "../scenario/index.ts";

/** A scenario's busy kit with the URL of each art file it has so far. */
export interface LoadedKit {
  scenarioID: string;
  kit: BusyKit;
  indicatorURL: string | null;
  clickURL: string | null;
  bedURL: string | null;
}

/**
 * The busy kit of a scenario, by default the one this page runs, read fresh on every call because
 * a written scenario's busy state and art land while its session already runs. Null until it has
 * a busy state.
 */
export function getBusyKit(scenarioID: string = currentScenarioID()): LoadedKit | null {
  const scenario = getScenario(scenarioID);
  if (scenario.busy === null) return null;
  return {
    scenarioID: scenario.id,
    kit: scenario.busy,
    indicatorURL: artURL(scenario, "indicator"),
    clickURL: artURL(scenario, "click"),
    bedURL: artURL(scenario, "bed"),
  };
}
