import { z } from "zod";
import { record } from "../run-log/index.ts";
import { WorldFile } from "../state/index.ts";
import { busyFiles, parseBusyMarkdown, type BusyFileName } from "./busy.ts";
import { scenarioFromFiles, type Scenario } from "./scenario.ts";

const premises = import.meta.glob<string>("../presets/*/premise.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const busyMarkdowns = import.meta.glob<string>("../presets/*/busy.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const worlds = import.meta.glob<unknown>("../presets/*/world.json", {
  import: "default",
  eager: true,
});
const pickers = import.meta.glob<unknown>("../presets/*/picker.json", {
  import: "default",
  eager: true,
});
const art = import.meta.glob<string>("../presets/*/busy/*", {
  query: "?url",
  import: "default",
  eager: true,
});

const trees = import.meta.glob<unknown>("../presets/*/moments/tree.json", {
  import: "default",
  eager: true,
});
const media = import.meta.glob<string>("../presets/*/moments/*.{mp4,jpg}", {
  query: "?url",
  import: "default",
  eager: true,
});

/** A folder's place on the picker: worlds sort by `order`, lowest first, the first one featured. */
const PickerFile = z.object({ order: z.number().int() });

const cardWidths = [320, 640, 960, 1344];

function cardOf(base: string): Scenario["card"] {
  const images = cardWidths.flatMap((width) => {
    const url = media[`${base}/moments/card-${String(width)}.jpg`];
    return url === undefined ? [] : [{ url, width }];
  });
  return images.length === 0
    ? null
    : { images, loopURL: media[`${base}/moments/card.mp4`] ?? null };
}

const folderOf = (path: string) => /^\.\.\/presets\/([^/]+)\//.exec(path)?.[1] ?? "";

function load(id: string): Scenario | null {
  const base = `../presets/${id}`;
  const premise = premises[`${base}/premise.md`];
  const world = WorldFile.safeParse(worlds[`${base}/world.json`]);
  if (premise === undefined || !world.success) {
    record("scenario_folder_invalid", { id, message: world.error?.message ?? "missing file" });
    return null;
  }
  const markdown = busyMarkdowns[`${base}/busy.md`];
  let busy = null;
  if (markdown !== undefined)
    try {
      busy = parseBusyMarkdown(markdown);
    } catch (error: unknown) {
      record("busy_kit_invalid", { id, message: String(error) });
    }
  const picker = PickerFile.safeParse(pickers[`${base}/picker.json`]);
  const scenario = {
    ...scenarioFromFiles(id, { premise, world: world.data, busy }, "folder"),
    order: picker.success ? picker.data.order : null,
  };
  const tree = trees[`${base}/moments/tree.json`];
  return tree === undefined
    ? scenario
    : {
        ...scenario,
        moments: { tree, mediaURL: (name) => media[`${base}/moments/${name}`] ?? null },
        card: cardOf(base),
      };
}

/** Every scenario folder under `src/presets/`, in folder name order, read through one path. */
export const folderScenarios: readonly Scenario[] = [
  ...new Set(Object.keys(premises).map(folderOf)),
]
  .sort()
  .flatMap((id) => {
    const scenario = load(id);
    return scenario === null ? [] : [scenario];
  });

/** The served URL of one art file in a scenario folder, or null when the folder has none. */
export function folderArtURL(id: string, file: BusyFileName): string | null {
  return art[`../presets/${id}/busy/${busyFiles[file]}`] ?? null;
}
