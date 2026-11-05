import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { phrase, phrases } from "../src/text/template.ts";
import { ffmpegCommand } from "./plumbing.ts";

/** Gemini Flash on OpenRouter with video input, checked live on 2026-11-02. */
export const judgeModel = "google/gemini-3.8-flash";
const judgeDeadlineMs = 180_000;
const attempts = 3;
const phrasing = phrases(
  readFileSync(join(import.meta.dirname, "..", "src", "eval", "judge-input.md"), "utf8"),
);
const say = (key: string, values: Record<string, string> = {}) =>
  phrase(phrasing, "judge-input.md", key, { newline: "\n", ...values });

const YesPartialNo = z.enum(["yes", "partial", "no"]);
export const Verdict = z.object({
  inputs: z.array(
    z.object({
      index: z.number(),
      clickedThingChanged: YesPartialNo,
      matchesIntendedState: YesPartialNo,
      note: z.string(),
    }),
  ),
  legibility: z.number().min(0).max(5),
  legibilityReason: z.string(),
  coherence: z.number().min(0).max(5),
  coherenceReason: z.string(),
  funny: z.number().min(1).max(5),
  funnyReason: z.string(),
  worst: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

const Event = z.looseObject({ kind: z.string(), t: z.number(), at: z.string() });
type Event = z.infer<typeof Event>;

export interface JudgeInput {
  directory: string;
  persona: string;
  caseName: string;
  events: readonly unknown[];
  videoPath: string;
  videoStartWall: number;
  crop: { x: number; y: number; width: number; height: number } | null;
  apiKey: string;
}

export interface JudgeResult {
  verdicts: Verdict[];
  gap: { legibility: number; coherence: number; funny: number; inputDisagreements: number } | null;
  cost: number;
  errors: string[];
}

function endSeconds(input: JudgeInput): number | null {
  const end = input.events
    .map((raw) => Event.safeParse(raw))
    .find((parsed) => parsed.success && parsed.data.kind === "run_end");
  if (end?.success !== true) return null;
  return (Date.parse(end.data.at) - input.videoStartWall) / 1000 + 0.5;
}

function compress(input: JudgeInput): string {
  const end = endSeconds(input);
  const output = join(input.directory, "judge-video.mp4");
  const crop =
    input.crop === null
      ? ""
      : `crop=${Math.round(input.crop.width / 2) * 2}:${Math.round(input.crop.height / 2) * 2}:${Math.round(input.crop.x)}:${Math.round(input.crop.y)},`;
  execFileSync(
    ffmpegCommand(),
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      input.videoPath,
      ...(end === null ? [] : ["-t", end.toFixed(2)]),
      "-vf",
      `${crop}scale=768:-2`,
      "-c:v",
      "libx264",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-an",
      output,
    ],
    { timeout: 120_000 },
  );
  return output;
}

/** The timeline the judge reads: actions, clip requests and intended states on the video's clock. */
export function buildTimeline(events: readonly unknown[], videoStartWall: number): string {
  const parsed = events.flatMap((raw) => {
    const event = Event.safeParse(raw);
    return event.success ? [event.data] : [];
  });
  const at = (event: Event) => ((Date.parse(event.at) - videoStartWall) / 1000).toFixed(1);
  const prompts = new Map(
    parsed
      .filter((event) => event.kind === "eval_clip" && typeof event.prompt === "string")
      .map((event) => [String(event.clipID), String(event.prompt)]),
  );
  let actionIndex = 0;
  const lines = parsed.flatMap((event): string[] => {
    if (event.kind === "eval_action") {
      const aimed = {
        at: at(event),
        intended: String(event.intendedElementID),
        intent: String(event.intent),
        landed: String(event.landedElementID),
      };
      if (event.accepted !== true) return [say("refused", aimed)];
      actionIndex++;
      return [
        say("action", {
          ...aimed,
          index: String(actionIndex),
          action: String(event.action),
          during: event.midClip === true ? say("during") : "",
        }),
      ];
    }
    if (event.kind === "clip_started")
      return [
        say("clip", { at: at(event), prompt: prompts.get(String(event.clipID)) ?? "unknown" }),
      ];
    if (event.kind === "eval_state")
      return [
        say("state", {
          at: at(event),
          scene: String(event.scene),
          elements: Array.isArray(event.elements) ? event.elements.join(", ") : "",
        }),
      ];
    if (event.kind === "run_end") return [say("end", { at: at(event) })];
    return [];
  });
  return lines.join("\n");
}

async function callJudge(input: JudgeInput, videoBase64: string, timeline: string, rubric: string) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(judgeDeadlineMs),
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: judgeModel,
      usage: { include: true },
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: rubric },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: say("input", { caseName: input.caseName, persona: input.persona, timeline }),
            },
            { type: "video_url", video_url: { url: `data:video/mp4;base64,${videoBase64}` } },
          ],
        },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return Completion.parse(await response.json());
}

/**
 * Has Gemini watch the session recording twice against the rubric, parses each reply with Zod
 * (retrying a reply that is not valid JSON up to three times), and reports the gap between them.
 */
export async function judgeRun(input: JudgeInput): Promise<JudgeResult> {
  const rubric = readFileSync(join(import.meta.dirname, "..", "src", "eval", "judge.md"), "utf8");
  const video = compress(input);
  const videoBase64 = readFileSync(video).toString("base64");
  const timeline = buildTimeline(input.events, input.videoStartWall);
  writeFileSync(join(input.directory, "judge-timeline.txt"), `${timeline}\n`);
  const verdicts: Verdict[] = [];
  const errors: string[] = [];
  let cost = 0;
  const runs = await Promise.all(
    [1, 2].map(async (pass) => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const completion = await callJudge(input, videoBase64, timeline, rubric);
          cost += completion.usage?.cost ?? 0;
          const content = completion.choices[0]?.message.content ?? "";
          const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
          const verdict = Verdict.parse(JSON.parse(json));
          writeFileSync(
            join(input.directory, `judge-${pass}.json`),
            `${JSON.stringify(verdict, null, 2)}\n`,
          );
          return verdict;
        } catch (error: unknown) {
          errors.push(`pass ${pass} attempt ${attempt}: ${String(error).slice(0, 300)}`);
        }
      }
      return null;
    }),
  );
  for (const run of runs) if (run !== null) verdicts.push(run);
  const [first, second] = verdicts;
  const gap =
    first === undefined || second === undefined
      ? null
      : {
          legibility: Math.abs(first.legibility - second.legibility),
          coherence: Math.abs(first.coherence - second.coherence),
          funny: Math.abs(first.funny - second.funny),
          inputDisagreements: first.inputs.filter((entry) => {
            const other = second.inputs.find((candidate) => candidate.index === entry.index);
            return (
              other === undefined ||
              other.clickedThingChanged !== entry.clickedThingChanged ||
              other.matchesIntendedState !== entry.matchesIntendedState
            );
          }).length,
        };
  const result = {
    model: judgeModel,
    videoBytes: statSync(video).size,
    verdicts,
    gap,
    cost,
    errors,
  };
  writeFileSync(join(input.directory, "judge.json"), `${JSON.stringify(result, null, 2)}\n`);
  return { verdicts, gap, cost, errors };
}

/** The judge's part of the summary line. */
export function summarizeJudge(result: JudgeResult): string {
  if (result.verdicts.length === 0) return `judge failed: ${result.errors.at(-1) ?? "no verdict"}`;
  const mean = (pick: (verdict: Verdict) => number) =>
    (
      result.verdicts.reduce((total, verdict) => total + pick(verdict), 0) / result.verdicts.length
    ).toFixed(1);
  const changed =
    result.verdicts[0]?.inputs.filter((entry) => entry.clickedThingChanged === "yes").length ?? 0;
  const total = result.verdicts[0]?.inputs.length ?? 0;
  return [
    `judge legibility ${mean((verdict) => verdict.legibility)} coherence ${mean((verdict) => verdict.coherence)} funny ${mean((verdict) => verdict.funny)}`,
    `clicked thing changed ${changed}/${total}`,
    result.gap === null
      ? "one judge pass only"
      : `judge gap ${result.gap.legibility}/${result.gap.coherence}/${result.gap.funny} inputs disagree ${result.gap.inputDisagreements}`,
    `judge $${result.cost.toFixed(4)}`,
  ].join(" | ");
}
