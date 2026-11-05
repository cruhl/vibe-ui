import { z } from "zod";

const Question = z.looseObject({
  type: z.string(),
  instructions: z.string().optional(),
  criteria: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional(),
});
const Request = z.object({ questions: z.record(z.string(), Question) });

/** Measured Jev latency sits between 0.13 and 0.3 seconds; the mock answers in the middle. */
export const jevLatencyMs = 200;

const slots = new Map<string, number>();

function cannedBox(slot: number) {
  const column = slot % 4;
  const row = Math.floor(slot / 4) % 4;
  const left = 0.06 + column * 0.23;
  const top = 0.22 + row * 0.18;
  return { top, bottom: top + 0.14, left, right: left + 0.18 };
}

function slotFor(instructions: string): number {
  const known = slots.get(instructions);
  if (known !== undefined) return known;
  const slot = slots.size;
  slots.set(instructions, slot);
  return slot;
}

const served = new Map<string, number>();

/**
 * The recorded answer for a question, by its type and text, in the order they were recorded and
 * staying on the last; null when the recording never asked it.
 */
function recordedAnswer(
  recorded: ReadonlyMap<string, readonly unknown[]>,
  type: string,
  instructions: string | undefined,
): unknown {
  if (instructions === undefined || type === "choice") return null;
  const id = `${type}|${instructions}`;
  const answers = recorded.get(id);
  if (answers === undefined || answers.length === 0) return null;
  const index = served.get(id) ?? 0;
  served.set(id, index + 1);
  return answers[Math.min(index, answers.length - 1)] ?? null;
}

/**
 * A Jev reply body for a request: the recorded answer when a replay kit asked the same question,
 * else one canned box per element in a grid, each element (by its label question) keeping its
 * first slot for the whole page, every presence check at 0.95, choices spread evenly and scores
 * at 0, so a run needs no Jev key or network while the real client builds and parses the call.
 */
export function answerJev(
  body: unknown,
  recorded: ReadonlyMap<string, readonly unknown[]> = new Map(),
): string {
  const parsed = Request.parse(body);
  const answers: Record<string, unknown> = Object.fromEntries(
    Object.entries(parsed.questions).map(([key, question]): [string, unknown] => {
      const replayed = recordedAnswer(recorded, question.type, question.instructions);
      if (replayed !== null) return [key, replayed];
      if (question.type === "box") {
        const label = parsed.questions[key.replace(/^box_/, "labeled_")]?.instructions ?? key;
        return [key, { type: "box", box: cannedBox(slotFor(label)), confidence: 0.9 }];
      }
      if (question.type === "choice") {
        const options = Object.keys(question.criteria ?? {});
        const share = options.length === 0 ? 0 : 1 / options.length;
        return [
          key,
          {
            type: "choice",
            choice: options[0] ?? "",
            probabilities: Object.fromEntries(options.map((option) => [option, share])),
          },
        ];
      }
      if (question.type === "score") return [key, { type: "score", score: 0 }];
      return [key, { type: "noul", noul: 0.95 }];
    }),
  );
  return JSON.stringify({
    model: "jev-mock",
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}
