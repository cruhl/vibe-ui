import { downloadBlob, zip } from "../capture/index.ts";
import { readSavedMoments } from "../moments/index.ts";
import { worldFileOf } from "../state/index.ts";
import { readArt } from "./art.ts";
import { busyFiles, busyMarkdown } from "./busy.ts";
import { findScenario, readSavedScenario } from "./registry.ts";

const textFile = (text: string, type: string) => new Blob([text], { type });

/**
 * A written scenario's folder files by path inside the folder: premise, world, busy state,
 * whatever busy art this browser has, and its saved moments (`moments/tree.json` and media).
 */
export async function scenarioFiles(id: string): Promise<Map<string, Blob> | null> {
  const scenario = findScenario(id);
  const saved = await readSavedScenario(id);
  if (scenario === null || saved === null) return null;
  const files = new Map<string, Blob>([
    [`${id}/premise.md`, textFile(saved.files.premise, "text/markdown")],
    [
      `${id}/world.json`,
      textFile(`${JSON.stringify(worldFileOf(scenario.world), null, 2)}\n`, "application/json"),
    ],
  ]);
  if (saved.files.busy !== null)
    files.set(
      `${id}/busy.md`,
      textFile(busyMarkdown(scenario.name, saved.files.busy), "text/markdown"),
    );
  for (const [name, blob] of await readArt(id)) files.set(`${id}/busy/${busyFiles[name]}`, blob);
  const moments = await readSavedMoments(id);
  if (moments !== null) {
    files.set(
      `${id}/moments/tree.json`,
      textFile(`${JSON.stringify(moments.tree, null, 2)}\n`, "application/json"),
    );
    for (const [name, blob] of moments.media) files.set(`${id}/moments/${name}`, blob);
  }
  return new Map([...files].map(([path, blob]) => [path.slice(id.length + 1), blob]));
}

/**
 * Packs a written scenario as a scenario folder, the same files every folder under `src/presets/`
 * holds, its saved moments included, so a folder dropped into `src/presets/` arrives baked.
 */
export async function scenarioFolder(id: string): Promise<Blob | null> {
  const files = await scenarioFiles(id);
  if (files === null) return null;
  return zip(new Map([...files].map(([path, blob]) => [`${id}/${path}`, blob])));
}

/** Downloads a written scenario as a zipped scenario folder, ready to drop into `src/presets/`. */
export async function downloadScenarioFolder(id: string): Promise<boolean> {
  const folder = await scenarioFolder(id);
  if (folder === null) return false;
  downloadBlob(folder, `${id}.zip`);
  return true;
}
