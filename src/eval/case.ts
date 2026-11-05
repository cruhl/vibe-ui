import { z } from "zod";
import { jsonBlock } from "../text/index.ts";

const Spread = z.object({ mean: z.number().nonnegative(), sd: z.number().nonnegative() });

export const HumanTiming = z.object({
  seed: z.number().int().describe("Seed for every random draw, so a run repeats exactly."),
  reactionMs: Spread.describe("Delay from seeing a frame to starting to act."),
  readingWordsPerMinute: z.number().positive().describe("Reading speed for text on screen."),
  glanceMs: z.number().positive().describe("Time between looks at the frame while waiting."),
  fittsMs: z
    .object({ a: z.number().nonnegative(), b: z.number().nonnegative() })
    .describe("Cursor travel: a + b * log2(distance / width + 1), in frame fractions."),
  hesitation: z.object({ chance: z.number().min(0).max(1), ms: Spread }),
  misclick: z.object({
    chance: z.number().min(0).max(1),
    spread: z.number().nonnegative().describe("Miss distance as a multiple of the box size."),
  }),
  typingCharsPerSecond: z.number().positive(),
  idle: z.object({ chance: z.number().min(0).max(1), ms: Spread }),
});
export type HumanTiming = z.infer<typeof HumanTiming>;

export const ScriptStep = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), elementID: z.string(), intent: z.string().optional() }),
  z.object({
    action: z.literal("click-point"),
    x: z.number(),
    y: z.number(),
    intent: z.string().optional(),
  }),
  z.object({
    action: z.literal("type"),
    elementID: z.string(),
    text: z.string(),
    intent: z.string().optional(),
  }),
  z.object({
    action: z.literal("click-label"),
    label: z.string().describe("Printed label of the element; skipped when absent once ready."),
    settled: z
      .boolean()
      .default(false)
      .describe("Wait for the previous clip to finish and hold before pressing."),
    intent: z.string().optional(),
  }),
  z.object({ action: z.literal("wait"), seconds: z.number().positive() }),
]);
export type ScriptStep = z.infer<typeof ScriptStep>;

export const EvalCaseConfig = z.object({
  preset: z.string().describe("Preset id the run opens with."),
  user: z
    .enum(["llm", "scripted"])
    .describe("llm: a model picks each action from the frame; scripted: the script runs in order."),
  script: z
    .array(ScriptStep)
    .default([])
    .describe("Inputs for the scripted user; each waits until its target box is on screen."),
  replay: z
    .string()
    .nullable()
    .default(null)
    .describe("Agent replay fixture in src/eval/replays used when the agent runs as replay."),
  human: HumanTiming,
  limits: z.object({
    maxInputs: z.number().int().positive().describe("Inputs the simulated user may send."),
    maxSeconds: z.number().positive().describe("Content seconds before the run is ended."),
  }),
  deadlines: z.object({
    firstClipSeconds: z.number().positive().describe("Run start to the first frame of a clip."),
    clickToFirstFrameSeconds: z
      .number()
      .positive()
      .describe("An accepted input to the first frame of the clip that answers it."),
    maxHoldSeconds: z
      .number()
      .positive()
      .describe(
        "Longest the stage holds between two clips once the next one, already asked for, is built.",
      ),
    maxBlackFrames: z.number().int().nonnegative().describe("Black frames logged while running."),
    readySeconds: z
      .number()
      .positive()
      .describe("Longest wait for a usable frame before the run counts as stalled."),
  }),
});
export type EvalCaseConfig = z.infer<typeof EvalCaseConfig>;

/** One eval case: the config block and the simulated user's persona and goal. */
export interface EvalCase extends EvalCaseConfig {
  name: string;
  persona: string;
}

/**
 * Parses an eval case file: a markdown document whose first fenced json block is the config and
 * whose remaining text is the persona and goal handed to the simulated user.
 */
export function parseEvalCase(name: string, text: string): EvalCase {
  const block = jsonBlock(text);
  if (block === null) throw new Error(`eval case ${name} has no fenced json config block`);
  const config = EvalCaseConfig.parse(block.json);
  const persona = block.rest;
  if (persona === "") throw new Error(`eval case ${name} has no persona text`);
  return { ...config, name, persona };
}
