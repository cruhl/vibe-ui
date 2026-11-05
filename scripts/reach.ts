import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { jevModel } from "../src/jev/model.ts";
import { phrase, phrases } from "../src/text/template.ts";
import { readEnvironment, root } from "./plumbing.ts";

const Moment = z.looseObject({
  key: z.string(),
  parentKey: z.string().nullable(),
  input: z.object({ elementID: z.string() }).nullable(),
  status: z.string(),
  held: z.string().nullable(),
  memory: z.object({ input: z.string() }),
  boxes: z.array(z.object({ elementID: z.string(), presence: z.number() })).nullable(),
});
type Moment = z.infer<typeof Moment>;
const Tree = z.looseObject({ moments: z.array(Moment) });
const Reply = z.object({
  answers: z.record(
    z.string(),
    z.looseObject({ type: z.string(), probabilities: z.record(z.string(), z.number()).optional() }),
  ),
});

/** How much of where a visitor plausibly goes stays inside a saved tree, click by click. */
export interface Reach {
  /** Moments filmed (ready) and written only. */
  filmed: number;
  written: number;
  /** Per click 1..n: the share of plausible paths whose every click so far plays from the tree. */
  filmedReach: number[];
  /** The same, counting a written-only moment as inside (it films at once, with no agent turn). */
  writtenReach: number[];
}

const presence = 0.5;
const clicks = 6;
const deadlineMs = 25_000;

/**
 * Jev's distribution over every boxed thing on one held frame: which the person most likely
 * chooses next, given what they did on the way there. Each thing is named by its id in words, so
 * guessed and unguessed things are described alike.
 */
async function nextChoices(
  key: string,
  frame: string,
  things: readonly string[],
  recent: readonly string[],
): Promise<Map<string, number>> {
  const reference = crypto.randomUUID();
  const phrasing = phrases(readFileSync(join(root, "src", "jev", "questions.md"), "utf8"));
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "TypeSafe-Danger-Zone-Images": "true",
    },
    body: JSON.stringify({
      model: jevModel,
      state: { frame: reference, recent: recent.join("\n") },
      assets: {
        [reference]: {
          type: "image",
          format: "jpg",
          data_base64: readFileSync(frame).toString("base64"),
        },
      },
      questions: {
        next: {
          type: "choice",
          instructions: phrase(phrasing, "questions.md", "next"),
          criteria: Object.fromEntries(
            things.map((id, index) => [
              `thing_${String(index)}`,
              `choose ${id.replace(/-/g, " ")}`,
            ]),
          ),
        },
      },
    }),
    signal: AbortSignal.timeout(deadlineMs),
  });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}: ${await response.text()}`);
  const probabilities = Reply.parse(await response.json()).answers.next?.probabilities ?? {};
  return new Map(things.map((id, index) => [id, probabilities[`thing_${String(index)}`] ?? 0]));
}

/**
 * Measures a scenario folder's saved tree against a plausible visitor: on every filmed moment's
 * held frame Jev spreads the next choice over every boxed thing, and the reach at click k is the
 * summed probability of every k-click path that stays inside the tree. Writes the numbers and
 * every distribution to `.agent/pregen/reach/<scenario>.json` and returns the numbers.
 */
export async function measureReach(folder: string): Promise<Reach | null> {
  const treePath = join(folder, "tree.json");
  if (!existsSync(treePath)) return null;
  const key = readEnvironment().TYPESAFE_API_KEY ?? "";
  if (key === "") throw new Error("TYPESAFE_API_KEY is missing from .env.local");
  const moments = Tree.parse(JSON.parse(readFileSync(treePath, "utf8"))).moments;
  const byKey = new Map(moments.map((moment) => [moment.key, moment]));
  const childrenOf = (moment: Moment) => moments.filter((other) => other.parentKey === moment.key);
  const pathOf = (moment: Moment): string[] => {
    const parent = moment.parentKey === null ? undefined : byKey.get(moment.parentKey);
    return parent === undefined ? [moment.memory.input] : [...pathOf(parent), moment.memory.input];
  };
  const filmed = moments.filter((moment) => moment.status === "ready" && moment.held !== null);
  const choices = new Map<string, Map<string, number>>();
  const queue = [...filmed];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let moment = queue.shift(); moment !== undefined; moment = queue.shift()) {
        const things = (moment.boxes ?? [])
          .filter((box) => box.presence >= presence)
          .map((box) => box.elementID);
        if (things.length === 0 || moment.held === null) continue;
        const choice = await nextChoices(
          key,
          join(folder, moment.held),
          things,
          pathOf(moment).slice(-6),
        ).catch(() => null);
        if (choice !== null) choices.set(moment.key, choice);
      }
    }),
  );
  const opening = moments.find((moment) => moment.parentKey === null);
  const reach = (inside: (moment: Moment) => boolean) => {
    const totals = Array.from({ length: clicks }, () => 0);
    const walk = (moment: Moment, depth: number, probability: number) => {
      if (depth >= clicks) return;
      const choice = choices.get(moment.key);
      if (choice === undefined) return;
      for (const child of childrenOf(moment)) {
        const share = child.input === null ? 0 : (choice.get(child.input.elementID) ?? 0);
        if (share === 0 || !inside(child)) continue;
        totals[depth] = (totals[depth] ?? 0) + probability * share;
        walk(child, depth + 1, probability * share);
      }
    };
    if (opening !== undefined) walk(opening, 0, 1);
    return totals.map((value) => Math.round(value * 1000) / 1000);
  };
  const result: Reach = {
    filmed: filmed.length,
    written: moments.length - filmed.length,
    filmedReach: reach((moment) => moment.status === "ready"),
    writtenReach: reach(() => true),
  };
  const out = join(root, ".agent", "pregen", "reach");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, `${basename(dirname(folder))}.json`),
    `${JSON.stringify({ ...result, choices: Object.fromEntries([...choices].map(([moment, choice]) => [moment, Object.fromEntries(choice)])) }, null, 2)}\n`,
  );
  return result;
}
