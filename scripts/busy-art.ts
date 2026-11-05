import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { falCall, falDownload } from "../src/assets/fal-client.ts";
import {
  artDeadlines,
  artModels,
  AudioResult,
  CutoutResult,
  cutoutRequest,
  ImageResult,
  paintRequest,
  soundRequest,
} from "../src/scenario/art-requests.ts";
import { busyFiles, parseBusyMarkdown, type BusyKit } from "../src/scenario/busy.ts";
import { ffmpegCommand, readEnvironment, root } from "./plumbing.ts";

const usage = `pnpm busy-art [folder ...] [--force]

Paints and records the busy art of each scenario folder in src/presets/ from the prompts in its
busy.md, once, with fal and the FAL_KEY in .env.local: the indicator (painted, cut out of its
background and scaled to 256 px) and the click and ambient bed sounds (loudness normalized with
ffmpeg), with the same models and requests the browser uses for a written scenario. Files land in
the folder's busy/ and are kept; an existing file is skipped unless --force. With no folder names,
every folder with a busy.md is done, so an exported scenario folder dropped into src/presets/ gets
its art the same way as every other.`;

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const force = argv.includes("--force");
const foldersDirectory = join(root, "src", "presets");
const key = readEnvironment().FAL_KEY;
if (key === undefined) throw new Error("FAL_KEY is missing from .env.local");
const named = argv.filter((arg) => !arg.startsWith("--"));
const folders = readdirSync(foldersDirectory).filter(
  (name) =>
    existsSync(join(foldersDirectory, name, "busy.md")) &&
    (named.length === 0 || named.includes(name)),
);

const call = (model: string, body: unknown, milliseconds: number) =>
  falCall(
    { baseURL: "https://fal.run", key, fetch },
    model,
    body,
    AbortSignal.timeout(milliseconds),
  );

async function download(url: string): Promise<Buffer> {
  const blob = await falDownload(url, AbortSignal.timeout(artDeadlines.download));
  return Buffer.from(await blob.arrayBuffer());
}

async function paintIndicator(kit: BusyKit, path: string): Promise<void> {
  const painted = ImageResult.parse(
    await call(artModels.paint, paintRequest(kit, false), artDeadlines.paint),
  );
  const cut = CutoutResult.parse(
    await call(
      artModels.cutout,
      cutoutRequest(painted.images[0]?.url ?? "", false),
      artDeadlines.cutout,
    ),
  );
  writeFileSync(path, await download(cut.image.url));
  execFileSync("sips", ["-Z", "256", path], { stdio: "ignore" });
}

async function record(kit: BusyKit, which: "click" | "bed", path: string): Promise<void> {
  const result = AudioResult.parse(
    await call(artModels.sound, soundRequest(kit, which), artDeadlines.sound),
  );
  writeFileSync(path, await download(result.audio.url));
  normalize(path, which === "bed" ? -28 : -18);
}

function normalize(path: string, loudness: number): void {
  const temporary = `${path}.tmp.mp3`;
  execFileSync(
    ffmpegCommand(),
    [
      "-loglevel",
      "error",
      "-y",
      "-i",
      path,
      "-af",
      `loudnorm=I=${loudness}:TP=-1.5`,
      "-ar",
      "44100",
      "-b:a",
      "96k",
      temporary,
    ],
    { stdio: "ignore" },
  );
  renameSync(temporary, path);
}

for (const folder of folders) {
  const kit = parseBusyMarkdown(readFileSync(join(foldersDirectory, folder, "busy.md"), "utf8"));
  const directory = join(foldersDirectory, folder, "busy");
  mkdirSync(directory, { recursive: true });
  const jobs: [string, () => Promise<void>][] = [
    [busyFiles.indicator, () => paintIndicator(kit, join(directory, busyFiles.indicator))],
    [busyFiles.click, () => record(kit, "click", join(directory, busyFiles.click))],
    [busyFiles.bed, () => record(kit, "bed", join(directory, busyFiles.bed))],
  ];
  await Promise.all(
    jobs.map(async ([file, run]) => {
      if (!force && existsSync(join(directory, file))) {
        process.stdout.write(`${folder}/${file}: kept\n`);
        return;
      }
      await run();
      process.stdout.write(`${folder}/${file}: written\n`);
    }),
  );
}
