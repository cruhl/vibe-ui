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
  const response = await connection.fetch(`${connection.baseURL}/v1/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.key}`,
      "Content-Type": "application/json",
      "TypeSafe-Danger-Zone-Images": "true",
    },
    body: JSON.stringify({
      model: connection.model,
      state: { frame: reference, recent: (extras.recent ?? []).join("\n") },
      assets: { [reference]: { type: "image", format: "jpg", data_base64: frameBase64 } },
      questions,
    }),
    signal,
  });
  if (!response.ok)
    throw new Error(`Jev HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const parsed = Response.parse(await response.json());
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
