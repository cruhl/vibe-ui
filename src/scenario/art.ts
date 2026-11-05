import { falCall, falDownload, type FalAccess } from "../assets/index.ts";
import { record, withDeadline } from "../run-log/index.ts";
import { get, put } from "../storage/index.ts";
import {
  artDeadlines,
  artModels,
  AudioResult,
  CutoutResult,
  cutoutRequest,
  ImageResult,
  paintRequest,
  soundRequest,
} from "./art-requests.ts";
import { busyFiles, type BusyFileName, type BusyKit } from "./busy.ts";
import { folderArtURL } from "./folders.ts";
import { notifyScenarios } from "./registry.ts";
import type { Scenario } from "./scenario.ts";

const artNames = Object.keys(busyFiles).filter((name): name is BusyFileName => name in busyFiles);
const loadedURLs = new Map<string, string>();
const loading = new Map<string, Promise<void>>();
const making = new Map<string, Promise<void>>();

const artKey = (id: string, file: BusyFileName) => `art/${id}/${busyFiles[file]}`;

/**
 * The URL of one busy art file of a scenario: served from its folder, or read from this browser
 * for a written one once `loadArt` has run. Null while the art is missing, and every reader then
 * falls back to a style that needs no art.
 */
export function artURL(scenario: Scenario, file: BusyFileName): string | null {
  if (scenario.origin === "folder") return folderArtURL(scenario.id, file);
  return loadedURLs.get(artKey(scenario.id, file)) ?? null;
}

/** The stored art of a written scenario as files, for export. */
export async function readArt(id: string): Promise<Map<BusyFileName, Blob>> {
  const found = new Map<BusyFileName, Blob>();
  for (const name of artNames) {
    const value = await get("scenarios", artKey(id, name));
    if (value instanceof Blob) found.set(name, value);
  }
  return found;
}

/** Reads a written scenario's stored art into URLs, once. */
export function loadArt(scenario: Scenario): Promise<void> {
  if (scenario.origin === "folder") return Promise.resolve();
  const existing = loading.get(scenario.id);
  if (existing !== undefined) return existing;
  const promise = readArt(scenario.id).then((found) => {
    for (const [name, blob] of found)
      loadedURLs.set(artKey(scenario.id, name), URL.createObjectURL(blob));
    if (found.size > 0) notifyScenarios();
  });
  loading.set(scenario.id, promise);
  return promise;
}

function call(
  fal: FalAccess,
  model: string,
  body: unknown,
  milliseconds: number,
): Promise<unknown> {
  return withDeadline(`fal_${model}`, milliseconds, (signal) => falCall(fal, model, body, signal));
}

function download(url: string): Promise<Blob> {
  return withDeadline("fal_download", artDeadlines.download, (signal) => falDownload(url, signal));
}

async function paintIndicator(fal: FalAccess, kit: BusyKit): Promise<Blob> {
  const painted = ImageResult.parse(
    await call(fal, artModels.paint, paintRequest(kit, true), artDeadlines.paint),
  );
  const cut = CutoutResult.parse(
    await call(
      fal,
      artModels.cutout,
      cutoutRequest(painted.images[0]?.url ?? "", true),
      artDeadlines.cutout,
    ),
  );
  return download(cut.image.url);
}

async function recordSound(fal: FalAccess, kit: BusyKit, which: "click" | "bed"): Promise<Blob> {
  const result = AudioResult.parse(
    await call(fal, artModels.sound, soundRequest(kit, which), artDeadlines.sound),
  );
  return download(result.audio.url);
}

/**
 * Paints and records whatever busy art a written scenario still lacks, all at once with fal (the
 * person's own key or the hosted route), each under its deadline. Each file is kept in this browser and shown the
 * moment it lands; a file that fails stays missing and is tried again the next time.
 */
export function makeArt(scenario: Scenario, fal: FalAccess | null): Promise<void> {
  const kit = scenario.busy;
  if (scenario.origin === "folder" || kit === null || fal === null) return Promise.resolve();
  const existing = making.get(scenario.id);
  if (existing !== undefined) return existing;
  const started = performance.now();
  const jobs: Record<BusyFileName, () => Promise<Blob>> = {
    indicator: () => paintIndicator(fal, kit),
    click: () => recordSound(fal, kit, "click"),
    bed: () => recordSound(fal, kit, "bed"),
  };
  const promise = loadArt(scenario).then(() =>
    Promise.all(
      artNames
        .filter((name) => !loadedURLs.has(artKey(scenario.id, name)))
        .map(async (name) => {
          try {
            const blob = await jobs[name]();
            await put("scenarios", artKey(scenario.id, name), blob);
            loadedURLs.set(artKey(scenario.id, name), URL.createObjectURL(blob));
            record("scenario_art_ready", {
              scenarioID: scenario.id,
              file: busyFiles[name],
              bytes: blob.size,
              milliseconds: Math.round(performance.now() - started),
            });
            notifyScenarios();
          } catch (error: unknown) {
            record("scenario_art_failed", {
              scenarioID: scenario.id,
              file: busyFiles[name],
              message: String(error),
            });
          }
        }),
    ).then(() => {
      making.delete(scenario.id);
    }),
  );
  making.set(scenario.id, promise);
  return promise;
}
