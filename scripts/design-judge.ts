import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { ffmpegCommand, readEnvironment } from "./plumbing.ts";

const usage = `node --experimental-strip-types scripts/design-judge.ts --prompt <file> --out <file>
    [--video <mp4>]... [--still <png>]... [--model <openrouter model>]

Shows screen recordings and stills to a video-capable model on OpenRouter (default
google/gemini-4-argon) with the prompt file's text as the whole instruction, and writes its reply to
--out. Each video is shrunk to at most 960 px wide at 15 fps first; each is preceded by a line naming
its file so the prompt can refer to it. The OpenRouter key comes from .env.local and is never printed.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.length === 0) {
  process.stdout.write(`${usage}\n`);
  process.exit(argv.length === 0 ? 1 : 0);
}
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const options = (name: string) =>
  argv.flatMap((arg, index) =>
    arg === `--${name}` && argv[index + 1] !== undefined ? [argv[index + 1] ?? ""] : [],
  );
const promptFile = option("prompt");
const out = option("out");
if (promptFile === null || out === null) {
  process.stdout.write(`${usage}\n`);
  process.exit(1);
}
const model = option("model") ?? "google/gemini-4-argon";
const key = readEnvironment().OPENROUTER_API_KEY;
if (key === undefined || key === "") {
  process.stdout.write("OPENROUTER_API_KEY is missing from .env.local\n");
  process.exit(1);
}

const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

const scratch = mkdtempSync(join(tmpdir(), "design-judge-"));
try {
  const content: unknown[] = [{ type: "text", text: readFileSync(promptFile, "utf8") }];
  for (const video of options("video")) {
    const small = join(scratch, `${basename(video, ".mp4")}.mp4`);
    execFileSync(
      ffmpegCommand(),
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        video,
        "-vf",
        "scale='min(960,iw)':-2,fps=15",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "28",
        "-an",
        small,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    content.push({ type: "text", text: `Video file: ${basename(video)}` });
    content.push({
      type: "video_url",
      video_url: { url: `data:video/mp4;base64,${readFileSync(small).toString("base64")}` },
    });
  }
  for (const still of options("still")) {
    content.push({ type: "text", text: `Still file: ${basename(still)}` });
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${readFileSync(still).toString("base64")}` },
    });
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) {
    process.stdout.write(
      `OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 400)}\n`,
    );
    process.exit(1);
  }
  const completion = Completion.parse(await response.json());
  const text = completion.choices[0]?.message.content ?? "";
  writeFileSync(out, text);
  process.stdout.write(
    `wrote ${out} (${text.length} characters, ${model}, cost ${completion.usage?.cost ?? "unknown"})\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
