import { z } from "zod";
import { viewOf } from "../projector/index.ts";
import { WorldFile, worldFromFile, type View, type World } from "../state/index.ts";
import { BusyKit } from "./busy.ts";

/**
 * A made-up world: the premise the agent reads, the starting world as entities, and the busy
 * state, which may still be on its way for a scenario being written.
 */
export interface Scenario {
  id: string;
  name: string;
  premise: string;
  /** The starting world as the view every domain reads. */
  initialView: View;
  /** The starting world as entities, for the projector. */
  world: World;
  busy: BusyKit | null;
  origin: "folder" | "written";
  /** The idea a written scenario came from. */
  idea: string | null;
  createdAt: string | null;
  /** Its baked moments, when a bake left them in its folder or this browser saved them. */
  moments: ScenarioMoments | null;
  /** The picker's art from its baked opening, when a bake left one in its folder. */
  card: ScenarioCard | null;
  /** Its place on the picker from its folder's `picker.json`, lowest first; null sorts last. */
  order: number | null;
}

/**
 * A world's picture for the picker, made by a bake from the tree's root: the opening's held frame
 * at a few widths, and a silent loop of its clip.
 */
export interface ScenarioCard {
  images: { url: string; width: number }[];
  loopURL: string | null;
}

/**
 * Where a scenario's baked moments are: the raw `tree.json` (checked by the moments domain before
 * any of it is used) and the served URL of each media file it names.
 */
export interface ScenarioMoments {
  tree: unknown;
  mediaURL: (name: string) => string | null;
}

/** Everything a scenario folder holds besides its art, as data. */
export const ScenarioFiles = z.object({
  premise: z.string(),
  world: WorldFile,
  busy: BusyKit.nullable(),
});
export type ScenarioFiles = z.infer<typeof ScenarioFiles>;

/** A written scenario as this browser keeps it. */
export const SavedScenario = z.object({
  id: z.string(),
  idea: z.string(),
  createdAt: z.string(),
  files: ScenarioFiles,
});
export type SavedScenario = z.infer<typeof SavedScenario>;

/** Builds a scenario from its files: the one path every scenario, folder or written, goes through. */
export function scenarioFromFiles(
  id: string,
  files: ScenarioFiles,
  origin: Scenario["origin"],
  idea: string | null = null,
  createdAt: string | null = null,
): Scenario {
  const world = worldFromFile(files.world);
  return {
    id,
    name: files.world.canon.name,
    premise: files.premise,
    initialView: viewOf(world),
    world,
    busy: files.busy,
    origin,
    idea,
    createdAt,
    moments: null,
    card: null,
    order: null,
  };
}
