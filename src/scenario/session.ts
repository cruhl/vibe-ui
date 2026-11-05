import { createStore } from "zustand/vanilla";
import { currentKeys, getFalAccess, getOpenAIAccess } from "../keys/index.ts";
import { currentRoute, scenarioURL, sharedScenarioURL } from "../route/index.ts";
import { record } from "../run-log/index.ts";
import { loadArt, makeArt } from "./art.ts";
import { readSavedMoments } from "../moments/index.ts";
import {
  attachMoments,
  findScenario,
  loadWrittenScenarios,
  readSavedScenario,
  saveScenario,
} from "./registry.ts";
import { SavedScenario } from "./scenario.ts";
import { writeScenario, type WriteStage } from "./write.ts";

/**
 * A write in progress or just failed, as the create flow shows it: the idea, the part arriving
 * now, the premise as far as it is written, the world's name once it is, and the id of the world
 * once it opened, which stays set until another write starts so the flow can follow its filming.
 */
export interface WriteState {
  idea: string | null;
  stage: WriteStage | null;
  characters: number;
  premise: string;
  name: string | null;
  launchedID: string | null;
  error: string | null;
}

/** The one write this page runs at a time. */
export const writeStore = createStore<WriteState>(() => ({
  idea: null,
  stage: null,
  characters: 0,
  premise: "",
  name: null,
  launchedID: null,
  error: null,
}));

let launcher: ((scenarioID: string) => void) | null = null;

/** Sets how this page starts a session on a scenario without a reload; the page root owns it. */
export function setScenarioLauncher(launch: (scenarioID: string) => void): void {
  launcher = launch;
}

/**
 * Starts a session on a scenario in this page, with no reload, when the page root has set a
 * launcher; false when it has not, so the caller navigates instead.
 */
export function launchScenario(scenarioID: string): boolean {
  if (launcher === null) return false;
  record("scenario_launched", { scenarioID });
  launcher(scenarioID);
  return true;
}

/** The full link that opens a scenario, any other parameters kept. */
export function scenarioLink(scenarioID: string): string {
  return new URL(scenarioURL(scenarioID), location.href).href;
}

/**
 * Runs before the page builds anything that reads a scenario: loads the scenarios this browser
 * wrote, and for a written scenario in the route reads its stored art and saved moments and makes
 * whatever art it still lacks.
 */
export async function prepareScenarios(): Promise<void> {
  await loadWrittenScenarios();
  const asked = currentRoute().scenario;
  if (asked !== null && findScenario(asked) === null) await openShared(asked);
  const current = findScenario(asked);
  if (current?.origin !== "written") return;
  await loadArt(current);
  const saved = await readSavedMoments(current.id);
  if (saved !== null) {
    const urls = new Map<string, string>();
    attachMoments(current.id, {
      tree: saved.tree,
      mediaURL: (name) => {
        const blob = saved.media.get(name);
        if (blob === undefined) return null;
        const url = urls.get(name) ?? URL.createObjectURL(blob);
        urls.set(name, url);
        return url;
      },
    });
    record("moments_restored", { scenarioID: current.id, moments: saved.tree.moments.length });
  }
  void makeArt(current, getFalAccess(currentKeys()));
}

const sharedDeadlineMs = 4000;

/** Reads a world someone shared from this site's store and keeps it in this browser. */
async function openShared(id: string): Promise<void> {
  try {
    const response = await fetch(`/api/worlds/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(sharedDeadlineMs),
    });
    if (!response.ok) {
      record("shared_world_missing", { scenarioID: id, status: response.status });
      return;
    }
    const saved = SavedScenario.parse(await response.json());
    if (saved.id !== id) throw new Error(`the store answered ${saved.id} for ${id}`);
    await saveScenario(saved);
    record("shared_world_opened", { scenarioID: id });
  } catch (error: unknown) {
    record("shared_world_failed", { scenarioID: id, message: String(error) });
  }
}

const shared = new Map<string, Promise<string>>();

/**
 * Puts a written world in this site's shared store, once per page, and resolves the link that
 * opens it in any browser. Only the world's text is sent: its premise, world and busy state.
 */
export function shareScenario(id: string): Promise<string> {
  const existing = shared.get(id);
  if (existing !== undefined) return existing;
  const promise = (async () => {
    const saved = await readSavedScenario(id);
    if (saved === null) throw new Error("this world is not saved in this browser");
    const response = await fetch("/api/worlds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saved),
    });
    if (!response.ok)
      throw new Error(
        `sharing answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    record("world_shared", { scenarioID: id });
    return sharedScenarioURL(id);
  })();
  shared.set(id, promise);
  promise.catch(() => shared.delete(id));
  return promise;
}

/**
 * Writes a scenario from an idea and starts a session on it the moment its premise and world
 * exist, then makes its busy art in parallel once the busy state has arrived.
 */
export async function writeAndLaunch(idea: string): Promise<void> {
  const trimmed = idea.trim();
  if (trimmed === "" || writeStore.getState().stage !== null) return;
  record("scenario_idea_submitted", { idea: trimmed });
  writeStore.setState({
    idea: trimmed,
    stage: "premise",
    characters: 0,
    premise: "",
    name: null,
    launchedID: null,
    error: null,
  });
  const keys = currentKeys();
  if (keys === null) {
    writeStore.setState({ stage: null, error: "no keys" });
    return;
  }
  try {
    const scenario = await writeScenario({
      idea: trimmed,
      openAI: getOpenAIAccess(keys),
      onProgress: (progress) => {
        writeStore.setState({
          stage: progress.stage,
          characters: progress.characters,
          premise: progress.premise,
          name: progress.name,
        });
      },
      onPlayable: (playable) => {
        writeStore.setState({ launchedID: playable.id, name: playable.name });
        if (launcher !== null) launcher(playable.id);
        else location.assign(scenarioLink(playable.id));
      },
    });
    writeStore.setState({ stage: null });
    await makeArt(scenario, getFalAccess(keys));
  } catch (error: unknown) {
    writeStore.setState({ stage: null, launchedID: null, error: String(error) });
  }
}
