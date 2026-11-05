import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { judgeModel } from "./eval-judge.ts";
import { ffmpegCommand, readEnvironment, root as repository } from "./plumbing.ts";

const usage = `node --experimental-strip-types scripts/payoff-judge.ts --proof <dir>... [--root <repo>]
    [--passes N]

Judges how much happens in every answer clip of a scenario-drive proof. For each proof directory
it reads result.json for the run id, the run log at <root>/.agent/runs/<runID>.jsonl and the
session recording at <root>/.agent/sessions/<runID>/recording.webm, cuts each answer clip from
its first frame for one clip length, saves frames every second and one contact sheet per clip
(payoff-<n>-sheet.jpg, left to right in time), and has Gemini on OpenRouter watch each clip
against src/eval/payoff-judge.md (default two passes). Writes payoff.json into the proof
directory and prints one line per clip and the means: action, changes, motion seconds, alive,
rests at end. <root> defaults to this repo.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.length === 0) {
  process.stdout.write(`${usage}\n`);
  process.exit(argv.length === 0 ? 1 : 0);
}
const values = (name: string) =>
  argv.flatMap((arg, index) =>
    arg === `--${name}` && argv[index + 1] !== undefined ? [argv[index + 1] ?? ""] : [],
  );
const root = resolve(values("root")[0] ?? repository);
const passes = Number(values("passes")[0] ?? 2);
const proofs = values("proof").map((path) => resolve(path));
const clipSeconds = 5.875;
const frameSeconds = [0.5, 1.5, 2.5, 3.5, 4.5, 5.6];
const apiKey = readEnvironment().OPENROUTER_API_KEY;
if (apiKey === undefined) throw new Error("payoff-judge needs OPENROUTER_API_KEY in .env.local");
const rubric = readFileSync(join(repository, "src", "eval", "payoff-judge.md"), "utf8");

const Event = z.looseObject({ kind: z.string(), t: z.number() });
type Event = z.infer<typeof Event>;
const Result = z.looseObject({ runID: z.string(), preset: z.string().nullable() });
const Input = z.looseObject({
  inputID: z.string(),
  input: z.looseObject({
    kind: z.string(),
    label: z.string().optional(),
    text: z.string().optional(),
  }),
});
const ClipEvent = z.looseObject({ clipID: z.string() });
const RecordingFirstFrame = z.looseObject({ recordingSeconds: z.number() });
const YesPartialNo = z.enum(["yes", "partial", "no"]);
const Score = z.object({
  action: z.number().min(0).max(5),
  changes: z.number().min(0),
  motionSeconds: z.number().min(0),
  alive: z.number().min(0).max(5),
  restsAtEnd: YesPartialNo,
  note: z.string(),
});
type Score = z.infer<typeof Score>;
const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

function readEvents(runID: string): Event[] {
  return readFileSync(join(root, ".agent", "runs", `${runID}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Event.parse(JSON.parse(line)));
}

function ffmpeg(args: string[]): void {
  execFileSync(ffmpegCommand(), ["-y", "-loglevel", "error", ...args], { timeout: 120_000 });
}

async function judgeClip(video: string, chosen: string): Promise<{ score: Score; cost: number }> {
  const base64 = readFileSync(video).toString("base64");
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(180_000),
        headers: { Authorization: `Bearer ${apiKey ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: judgeModel,
          usage: { include: true },
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: rubric },
            {
              role: "user",
              content: [
                { type: "text", text: `Just before this clip, the person ${chosen}.` },
                { type: "video_url", video_url: { url: `data:video/mp4;base64,${base64}` } },
              ],
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
      const completion = Completion.parse(await response.json());
      const content = completion.choices[0]?.message.content ?? "";
      const score = Score.parse(
        JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)),
      );
      return { score, cost: completion.usage?.cost ?? 0 };
    } catch (error: unknown) {
      lastError = String(error).slice(0, 300);
    }
  }
  throw new Error(`judge failed: ${lastError}`);
}

const mean = (numbers: number[]) =>
  numbers.length === 0 ? 0 : numbers.reduce((total, value) => total + value, 0) / numbers.length;
const restValue = { yes: 1, partial: 0.5, no: 0 } as const;

async function judgeProof(proof: string) {
  const result = Result.parse(JSON.parse(readFileSync(join(proof, "result.json"), "utf8")));
  const events = readEvents(result.runID);
  const recording = join(root, ".agent", "sessions", result.runID, "recording.webm");
  if (!existsSync(recording)) throw new Error(`no recording at ${recording}`);
  const firstFrameEvent = events.find((event) => event.kind === "recording_first_frame");
  if (firstFrameEvent === undefined) throw new Error("the run log has no recording_first_frame");
  const offset = firstFrameEvent.t - RecordingFirstFrame.parse(firstFrameEvent).recordingSeconds;
  const answers = events.flatMap((event, index) => {
    if (event.kind !== "input") return [];
    const parsed = Input.parse(event);
    if (parsed.input.kind === "start") return [];
    const firstFrame = events
      .slice(index + 1)
      .find((later) => later.kind === "first_frame" && later.t > event.t);
    if (firstFrame === undefined) return [];
    const chosen =
      parsed.input.kind === "instruct"
        ? `told the world: ${parsed.input.text ?? ""}`
        : parsed.input.kind === "type"
          ? `typed ${parsed.input.text ?? ""} into ${parsed.input.label ?? ""}`
          : `chose ${(parsed.input.label ?? "").toLowerCase()}`;
    return [{ chosen, clipID: ClipEvent.parse(firstFrame).clipID, start: firstFrame.t - offset }];
  });
  const clips = [];
  let cost = 0;
  for (const [index, answer] of answers.entries()) {
    const number = index + 1;
    const video = join(proof, `payoff-${number}.mp4`);
    ffmpeg([
      "-ss",
      answer.start.toFixed(2),
      "-i",
      recording,
      "-t",
      String(clipSeconds),
      "-vf",
      "scale=768:-2",
      "-c:v",
      "libx264",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-an",
      video,
    ]);
    const length = Number(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        video,
      ]).toString(),
    );
    for (const seconds of frameSeconds)
      ffmpeg([
        "-ss",
        Math.min(seconds, Math.max(0, length - 0.1)).toFixed(2),
        "-i",
        video,
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        "3",
        join(proof, `payoff-${number}-${seconds}s.jpg`),
      ]);
    ffmpeg([
      ...frameSeconds.flatMap((seconds) => ["-i", join(proof, `payoff-${number}-${seconds}s.jpg`)]),
      "-filter_complex",
      `${frameSeconds.map((_seconds, i) => `[${i}:v]scale=384:-2[f${i}]`).join(";")};${frameSeconds.map((_seconds, i) => `[f${i}]`).join("")}xstack=inputs=${frameSeconds.length}:layout=${frameSeconds.map((_seconds, i) => `${(i % 3) * 384}_${Math.floor(i / 3) === 0 ? "0" : "h0"}`).join("|")}`,
      "-pix_fmt",
      "yuvj420p",
      "-q:v",
      "3",
      join(proof, `payoff-${number}-sheet.jpg`),
    ]);
    const scores = await Promise.all(
      Array.from({ length: passes }, async () => {
        const judged = await judgeClip(video, answer.chosen);
        cost += judged.cost;
        return judged.score;
      }),
    );
    clips.push({ number, chosen: answer.chosen, clipID: answer.clipID, scores });
    const first = scores[0];
    process.stdout.write(
      `${result.preset ?? ""} ${number} (${answer.chosen.slice(0, 50)}): action ${mean(scores.map((score) => score.action)).toFixed(1)} changes ${mean(scores.map((score) => score.changes)).toFixed(1)} motion ${mean(scores.map((score) => score.motionSeconds)).toFixed(1)} s alive ${mean(scores.map((score) => score.alive)).toFixed(1)} rests ${scores.map((score) => score.restsAtEnd).join("/")} | ${first?.note ?? ""}\n`,
    );
  }
  const all = clips.flatMap((clip) => clip.scores);
  const summary = {
    action: Number(mean(all.map((score) => score.action)).toFixed(2)),
    changes: Number(mean(all.map((score) => score.changes)).toFixed(2)),
    motionSeconds: Number(mean(all.map((score) => score.motionSeconds)).toFixed(2)),
    alive: Number(mean(all.map((score) => score.alive)).toFixed(2)),
    restsAtEnd: Number(mean(all.map((score) => restValue[score.restsAtEnd])).toFixed(2)),
  };
  writeFileSync(
    join(proof, "payoff.json"),
    `${JSON.stringify({ model: judgeModel, passes, summary, clips, cost }, null, 2)}\n`,
  );
  process.stdout.write(
    `${proof}: mean action ${summary.action} changes ${summary.changes} motion ${summary.motionSeconds} s alive ${summary.alive} rests ${summary.restsAtEnd} ($${cost.toFixed(4)})\n`,
  );
}

for (const proof of proofs) await judgeProof(proof);
