import { z } from "zod";
import type { ViewElement } from "../state/index.ts";
import { phrase, phrases } from "../text/index.ts";
import questionText from "./questions.md?raw";

const questionPhrasing = phrases(questionText);
const question = (key: string, values: Readonly<Record<string, string>> = {}) =>
  phrase(questionPhrasing, "questions.md", key, values);
const degradationLevels = [0, 1, 2, 3].map((level) => question(`degradation-${String(level)}`));

/** Where Jev answers, with which key and model, and the `fetch` that sends each request. */
export interface JevConnection {
  baseURL: string;
  key: string;
  model: string;
  fetch: typeof fetch;
}

/** One question of a Jev request, as its API takes it. */
export type Question =
  | { type: "box" | "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export const Box = z.object({
  top: z.number(),
  bottom: z.number(),
  left: z.number(),
  right: z.number(),
});
export type Box = z.infer<typeof Box>;

const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("box"), box: Box, confidence: z.number().nullable() }),
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.looseObject({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
  }),
  z.looseObject({ type: z.literal("score"), score: z.number() }),
]);

const Response = z.object({
  model: z.string(),
  answers: z.record(z.string(), Answer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

/** Sends one request: `state` names each image by its reference in `images`, JPEG base64. */
async function ask(
  connection: JevConnection,
  state: Record<string, string>,
  images: Record<string, string>,
  questions: Record<string, Question>,
  signal: AbortSignal,
) {
  const response = await connection.fetch(`${connection.baseURL}/v1/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.key}`,
      "Content-Type": "application/json",
      "TypeSafe-Danger-Zone-Images": "true",
    },
    body: JSON.stringify({
      model: connection.model,
      state,
      assets: Object.fromEntries(
        Object.entries(images).map(([reference, base64]) => [
          reference,
          { type: "image", format: "jpg", data_base64: base64 },
        ]),
      ),
      questions,
    }),
    signal,
  });
  if (!response.ok)
    throw new Error(`Jev HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return Response.parse(await response.json());
}

/** Deadline in milliseconds for one Jev request, from measured 0.13 to 0.3 s plus headroom. */
export const jevDeadline = 2000;

/** Where Jev found one element in a frame, and how sure it is that the element is there. */
export interface ElementBox {
  elementID: string;
  box: Box;
  confidence: number | null;
  presence: number;
}

export interface BoxResult {
  boxes: ElementBox[];
  likelihoods: number[] | null;
  degradation: number | null;
  inputTokens: number;
  model: string;
  questions: Record<string, Question>;
  answers: Record<string, unknown>;
}

/** Extra judgments that ride in the same request as the boxes. */
export interface BoxExtras {
  /** Descriptions of guessed next inputs to rank by how likely the person is to do each next. */
  guesses?: readonly string[];
  /** Recent history for the ranking, oldest first. */
  recent?: readonly string[];
  /** Whether to score how degraded the picture is, 0 crisp to 3 badly degraded. */
  degradation?: boolean;
}

/**
 * Asks Jev for one box and two presence checks per element on a single frame, all in one request,
 * with the questions of `questions.md` filled with the element's own `look` sentence and label,
 * written by the agent. Presence is the higher of the two checks: a look sentence can misdescribe
 * a drawing, and an element can have no printed label.
 */
export async function boxElements(
  connection: JevConnection,
  frameBase64: string,
  elements: readonly ViewElement[],
  signal: AbortSignal,
  extras: BoxExtras = {},
): Promise<BoxResult> {
  const guesses = extras.guesses ?? [];
  if (elements.length === 0 && guesses.length === 0 && extras.degradation !== true)
    return {
      boxes: [],
      likelihoods: null,
      degradation: null,
      inputTokens: 0,
      model: connection.model,
      questions: {},
      answers: {},
    };
  const reference = crypto.randomUUID();
  const questions: Record<string, Question> = {};
  if (guesses.length > 0)
    questions.next = {
      type: "choice",
      instructions: question("next"),
      criteria: Object.fromEntries(guesses.map((guess, index) => [`guess_${index}`, guess])),
    };
  if (extras.degradation === true)
    questions.degradation = {
      type: "score",
      instructions: question("degradation"),
      criteria: degradationLevels,
    };
  elements.forEach((element, index) => {
    questions[`box_${index}`] = { type: "box", instructions: question("box", element) };
    questions[`present_${index}`] = { type: "noul", instructions: question("present", element) };
    questions[`labeled_${index}`] = { type: "noul", instructions: question("labeled", element) };
  });
  const parsed = await ask(
    connection,
    { frame: reference, recent: (extras.recent ?? []).join("\n") },
    { [reference]: frameBase64 },
    questions,
    signal,
  );
  const boxes = elements.flatMap((element, index): ElementBox[] => {
    const box = parsed.answers[`box_${index}`];
    const present = parsed.answers[`present_${index}`];
    const labeled = parsed.answers[`labeled_${index}`];
    if (box?.type !== "box" || present?.type !== "noul" || labeled?.type !== "noul") return [];
    return [
      {
        elementID: element.id,
        box: box.box,
        confidence: box.confidence,
        presence: Math.max(present.noul, labeled.noul),
      },
    ];
  });
  const next = parsed.answers.next;
  const degradation = parsed.answers.degradation;
  return {
    boxes,
    likelihoods:
      next?.type === "choice"
        ? guesses.map((_guess, index) => next.probabilities[`guess_${index}`] ?? 0)
        : null,
    degradation: degradation?.type === "score" ? degradation.score : null,
    inputTokens: parsed.usage.input_tokens,
    model: parsed.model,
    questions,
    answers: parsed.answers,
  };
}

/** A thing in view that a point can land on: its id, its look sentence and how it looks now. */
export interface PointCandidate {
  id: string;
  look: string;
  state: string | null;
}

/** Which thing Jev sees at a point, or null for open background, and how sure it is. */
export interface PointResult {
  thingID: string | null;
  probability: number;
  inputTokens: number;
  model: string;
  questions: Record<string, Question>;
  answers: Record<string, unknown>;
}

/**
 * Asks Jev which thing in view is at the center of `cropBase64`, a crop of `frameBase64` around
 * the point the person chose: one choice among the candidates' look sentences and open background,
 * with the questions of `questions.md`. Both images go in one request, so the crop is read in
 * the context of the whole frame.
 */
export async function pointAt(
  connection: JevConnection,
  frameBase64: string,
  cropBase64: string,
  candidates: readonly PointCandidate[],
  signal: AbortSignal,
): Promise<PointResult> {
  const frame = crypto.randomUUID();
  const crop = crypto.randomUUID();
  const criteria: Record<string, string> = Object.fromEntries(
    candidates.map((candidate, index) => [
      `thing_${index}`,
      candidate.state === null
        ? question("point-thing", { look: candidate.look })
        : question("point-thing-now", { look: candidate.look, state: candidate.state }),
    ]),
  );
  criteria.open = question("point-open");
  const questions: Record<string, Question> = {
    point: { type: "choice", instructions: question("point"), criteria },
  };
  const parsed = await ask(
    connection,
    { frame, crop },
    { [frame]: frameBase64, [crop]: cropBase64 },
    questions,
    signal,
  );
  const answer = parsed.answers.point;
  const index = answer?.type === "choice" ? /^thing_(\d+)$/.exec(answer.choice)?.[1] : undefined;
  const chosen = index === undefined ? undefined : candidates[Number(index)];
  return {
    thingID: chosen?.id ?? null,
    probability: answer?.type === "choice" ? (answer.probabilities[answer.choice] ?? 0) : 0,
    inputTokens: parsed.usage.input_tokens,
    model: parsed.model,
    questions,
    answers: parsed.answers,
  };
}
