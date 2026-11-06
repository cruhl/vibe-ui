import { useSyncExternalStore } from "react";
import { currentRoute } from "../route/index.ts";
import { record } from "../run-log/index.ts";
import { get, keys, put } from "../storage/index.ts";
import { folderScenarios } from "./folders.ts";
import { SavedScenario, scenarioFromFiles, type Scenario } from "./scenario.ts";

const written = new Map<string, Scenario>();
const listeners = new Set<() => void>();
let version = 0;
const placed = (scenario: Scenario) => scenario.order ?? Number.MAX_SAFE_INTEGER;
const pickerFolders = [...folderScenarios].sort((first, second) => placed(first) - placed(second));
let listed: readonly Scenario[] = pickerFolders;

const savedKey = (id: string) => `scenario/${id}`;

/** Tells every listener that a scenario, its busy state or its art changed. */
export function notifyScenarios(): void {
  version++;
  listed = [
    ...pickerFolders,
    ...[...written.values()].sort((first, second) =>
      (second.createdAt ?? "").localeCompare(first.createdAt ?? ""),
    ),
  ];
  for (const listener of listeners) listener();
}

/** Calls the listener after every change to any scenario; returns the remover. */
export function subscribeScenarios(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A counter that moves on every scenario change, for views that read scenarios directly. */
export function scenariosVersion(): number {
  return version;
}

/** Every scenario: the folders first in their picker order, then written ones, newest first. */
export function listScenarios(): readonly Scenario[] {
  return listed;
}

/** The scenario list, re-rendering on every change. */
export function useScenarios(): readonly Scenario[] {
  return useSyncExternalStore(subscribeScenarios, listScenarios);
}

/** The scenario with this id, or null. */
export function findScenario(id: string | null): Scenario | null {
  if (id === null) return null;
  return written.get(id) ?? folderScenarios.find((scenario) => scenario.id === id) ?? null;
}

/** The scenario with this id, or the first folder scenario. */
export function getScenario(id: string | null): Scenario {
  const found = findScenario(id);
  if (found !== null) return found;
  const first = folderScenarios[0];
  if (first === undefined) throw new Error("No scenario folders are defined.");
  return first;
}

/** The scenario this page runs, from the page's route. */
export function currentScenarioID(): string {
  return getScenario(currentRoute().scenario).id;
}

/** Saves a written scenario in this browser and makes it current for every reader. */
export async function saveScenario(saved: SavedScenario): Promise<Scenario> {
  const scenario = scenarioFromFiles(saved.id, saved.files, "written", saved.idea, saved.createdAt);
  written.set(saved.id, scenario);
  notifyScenarios();
  await put("scenarios", savedKey(saved.id), saved);
  return scenario;
}

/** Gives a written scenario the moments this browser saved for it, for every later reader. */
export function attachMoments(id: string, moments: Scenario["moments"]): void {
  const scenario = written.get(id);
  if (scenario === undefined) return;
  written.set(id, { ...scenario, moments });
  notifyScenarios();
}

/** The stored form of a written scenario, for export. */
export async function readSavedScenario(id: string): Promise<SavedScenario | null> {
  const parsed = SavedScenario.safeParse(await get("scenarios", savedKey(id)));
  return parsed.success ? parsed.data : null;
}

/** Reads every written scenario this browser saved, once, before anything asks for one. */
export async function loadWrittenScenarios(): Promise<void> {
  for (const key of await keys("scenarios", "scenario/")) {
    const parsed = SavedScenario.safeParse(await get("scenarios", key));
    if (!parsed.success) {
      record("scenario_saved_invalid", { key, message: parsed.error.message });
      continue;
    }
    try {
      const saved = parsed.data;
      written.set(
        saved.id,
        scenarioFromFiles(saved.id, saved.files, "written", saved.idea, saved.createdAt),
      );
    } catch (error: unknown) {
      record("scenario_saved_invalid", { key, message: String(error) });
    }
  }
  notifyScenarios();
}
