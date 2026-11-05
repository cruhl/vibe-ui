import { z } from "zod";
import { record } from "../run-log/index.ts";
import { get, keys, put } from "../storage/index.ts";
import { BakedMoment, BakeHashes, type BakedTree } from "./manifest.ts";

const Saved = z.object({
  record: BakedMoment,
  hashes: BakeHashes,
  clip: z.instanceof(Blob).nullable(),
  held: z.instanceof(Blob).nullable(),
});

const savedKey = (scenarioID: string, key: string) => `${scenarioID}/${key}`;

/**
 * Saves one moment of a written scenario in this browser, in the shape of a baked tree's moment,
 * with its clip and held frame when it was filmed. Never throws.
 */
export async function saveMoment(
  scenarioID: string,
  moment: BakedMoment,
  hashes: BakeHashes,
  clip: Blob | null,
  held: Blob | null,
): Promise<void> {
  await put("moments", savedKey(scenarioID, moment.key), { record: moment, hashes, clip, held });
}

/**
 * A written scenario's saved moments as a baked tree, parents first from its root, with the media
 * each one names; null when this browser saved none.
 */
export async function readSavedMoments(
  scenarioID: string,
): Promise<{ tree: BakedTree; media: Map<string, Blob> } | null> {
  const entries: z.infer<typeof Saved>[] = [];
  for (const key of await keys("moments", `${scenarioID}/`)) {
    const parsed = Saved.safeParse(await get("moments", key));
    if (parsed.success) entries.push(parsed.data);
    else record("moment_saved_invalid", { key, message: parsed.error.message });
  }
  const root = entries.find((entry) => entry.record.parentKey === null);
  if (root === undefined) return null;
  const byParent = new Map<string, z.infer<typeof Saved>[]>();
  for (const entry of entries) {
    const parentKey = entry.record.parentKey;
    if (parentKey !== null) byParent.set(parentKey, [...(byParent.get(parentKey) ?? []), entry]);
  }
  const ordered: z.infer<typeof Saved>[] = [];
  const visit = (entry: z.infer<typeof Saved>) => {
    ordered.push(entry);
    for (const child of (byParent.get(entry.record.key) ?? []).sort(
      (first, second) => first.record.index - second.record.index,
    ))
      visit(child);
  };
  visit(root);
  const media = new Map<string, Blob>();
  for (const entry of ordered) {
    if (entry.record.clip !== null && entry.clip !== null) media.set(entry.record.clip, entry.clip);
    if (entry.record.held !== null && entry.held !== null) media.set(entry.record.held, entry.held);
  }
  return {
    tree: {
      version: 1,
      scenario: scenarioID,
      bakedAt: new Date().toISOString(),
      hashes: root.hashes,
      moments: ordered.map((entry) => entry.record),
    },
    media,
  };
}
