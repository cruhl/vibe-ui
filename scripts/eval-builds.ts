import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const usage = `pnpm eval:builds

Reads every real run log in .agent/runs/*.jsonl and writes the measured build seconds of each
clip to src/omni/mock-builds.json, split into fresh clips and continued clips. The mock Omni
client replays these in order, so mock runs build at the speed real sessions measured.`;

if (process.argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

const Event = z.looseObject({ kind: z.string() });
const Enqueue = z.object({ inputID: z.string(), continueFromClipID: z.string().nullable() });
const Queued = z.object({ inputID: z.string(), clipID: z.string() });
const Generated = z.object({ clipID: z.string(), buildSeconds: z.number().nullable() });

const root = join(import.meta.dirname, "..");
const directory = join(root, ".agent", "runs");
const fresh: number[] = [];
const continued: number[] = [];
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".jsonl"))
  .sort();
for (const name of files) {
  const events = readFileSync(join(directory, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Event.parse(JSON.parse(line)));
  const continuedInputs = new Set<string>();
  const continuedClips = new Set<string>();
  for (const event of events) {
    if (event.kind === "enqueue") {
      const enqueue = Enqueue.safeParse(event);
      if (enqueue.success && enqueue.data.continueFromClipID !== null)
        continuedInputs.add(enqueue.data.inputID);
    }
    if (event.kind === "clip_queued") {
      const queued = Queued.safeParse(event);
      if (queued.success && continuedInputs.has(queued.data.inputID))
        continuedClips.add(queued.data.clipID);
    }
    if (event.kind === "clip_generated") {
      const generated = Generated.safeParse(event);
      if (!generated.success || generated.data.buildSeconds === null) continue;
      (continuedClips.has(generated.data.clipID) ? continued : fresh).push(
        generated.data.buildSeconds,
      );
    }
  }
}
if (fresh.length === 0 || continued.length === 0)
  throw new Error("the run logs hold no fresh or no continued build times");
const output = join(root, "src", "omni", "mock-builds.json");
writeFileSync(output, `${JSON.stringify({ runs: files.length, fresh, continued }, null, 2)}\n`);
process.stdout.write(
  `${output}: ${fresh.length} fresh, ${continued.length} continued builds from ${files.length} runs\n`,
);
