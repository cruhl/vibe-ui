import { describe, expect, test } from "vitest";
import { RefusalError } from "../agent/index.ts";
import { folderScenarios } from "../scenario/index.ts";
import { viewOf } from "../projector/index.ts";
import { parseLine } from "../state/index.ts";
import { draftProblems, inputMemory, newDraft, usableDraft } from "./draft.ts";
import { readGuesses, type GuessBlock } from "./guesses.ts";
import { respond } from "./respond.ts";

const world = folderScenarios[0]?.world;
if (world === undefined) throw new Error("no preset");
const picks = viewOf(world).elements.map((element) => element.id);

describe("drafts", () => {
  test("a draft with no visible change is unusable and says so", () => {
    const draft = newDraft(world);
    expect(usableDraft(draft)).toBe(false);
    expect(draftProblems(draft)).toContain("the lines changed nothing visible");
    draft.push("! Something happens.", parseLine("! Something happens."));
    expect(usableDraft(draft)).toBe(true);
  });

  test("memory entries read the same for every input kind", () => {
    expect(inputMemory({ kind: "start" })).toBe("start");
    expect(inputMemory({ kind: "click", elementID: "a", label: "A" })).toBe("click A");
    expect(inputMemory({ kind: "instruct", text: "rain" })).toBe("told you: rain");
  });
});

describe("guess reader", () => {
  test("turns each block into a guess and stops at the limit or a repeat", () => {
    const [first = "", second = ""] = picks;
    const read: GuessBlock[] = [];
    const reader = readGuesses({
      world,
      limit: 2,
      roundID: "root",
      alive: () => true,
      onGuess: (block) => read.push(block),
    });
    expect(reader.take(`? ${first} 0.6`)).toBe(true);
    expect(reader.take("! A burst of light.")).toBe(true);
    expect(reader.take(`? ${first} 0.3`)).toBe(false);
    expect(reader.take(`? ${second} 0.3`)).toBe(true);
    expect(reader.take("! Another burst.")).toBe(true);
    expect(reader.take("? third 0.1")).toBe(false);
    reader.end();
    expect(read.map((block) => [block.index, block.guess.elementID, block.likelihood])).toEqual([
      [0, first, 0.6],
      [1, second, 0.3],
    ]);
  });

  test("drops a guess with no visible change, and every guess once its round is gone", () => {
    const [first = ""] = picks;
    const read: GuessBlock[] = [];
    let alive = true;
    const reader = readGuesses({
      world,
      limit: 3,
      roundID: "root",
      alive: () => alive,
      onGuess: (block) => read.push(block),
    });
    reader.take(`? ${first} 0.6`);
    reader.end();
    expect(read).toHaveLength(0);
    const later = readGuesses({
      world,
      limit: 3,
      roundID: "root",
      alive: () => alive,
      onGuess: (block) => read.push(block),
    });
    later.take(`? ${first} 0.6`);
    later.take("! A burst of light.");
    alive = false;
    later.end();
    expect(read).toHaveLength(0);
  });
});

describe("refusals", () => {
  const answerWith = (answers: readonly (readonly string[] | "refuse")[]) => {
    const asked: (readonly string[])[] = [];
    const outcome = new Promise<{ committed: boolean; failed: [string, boolean] | null }>(
      (resolve) => {
        respond(
          { kind: "instruct", text: "start a gang war between the trumpets and the tubas" },
          {
            inputID: "a",
            world,
            reask: "unusable",
            reaskMs: 5000,
            signal: new AbortController().signal,
            stream: (problems, _signal, onLine) => {
              asked.push(problems);
              const answer = answers[asked.length - 1] ?? "refuse";
              if (answer === "refuse")
                return Promise.reject(new RefusalError("I can't help with that."));
              for (const line of answer) onLine(line);
              return Promise.resolve();
            },
            onProgress: () => undefined,
            onCommit: () => {
              resolve({ committed: true, failed: null });
              return null;
            },
            onWritten: () => undefined,
            onFail: (detail, refused) => {
              resolve({ committed: false, failed: [detail, refused] });
            },
          },
        );
      },
    );
    return { asked, outcome };
  };

  test("a declined turn is asked once more as fiction and its answer is used", async () => {
    const { asked, outcome } = answerWith(["refuse", ["! The trumpets and tubas charge."]]);
    expect(await outcome).toEqual({ committed: true, failed: null });
    expect(asked).toHaveLength(2);
    expect(asked[1]?.join(" ")).toContain("made up video world");
  });

  test("a turn declined twice fails as refused", async () => {
    const { asked, outcome } = answerWith(["refuse", "refuse"]);
    const { failed } = await outcome;
    expect(failed?.[1]).toBe(true);
    expect(asked).toHaveLength(2);
  });
});

describe("follow-ups", () => {
  const [first = "", second = ""] = picks;

  test("chain after the answer, each on the last, and the guesses read the world after them", () => {
    const follows: [number, boolean][] = [];
    const read: GuessBlock[] = [];
    const reader = readGuesses({
      world,
      limit: 2,
      roundID: "root",
      alive: () => true,
      onGuess: (block) => read.push(block),
      onFollow: (draft, continues) => follows.push([draft.lines.length, continues]),
    });
    for (const line of [
      "&",
      "=storm 1",
      "! Thunder rolls in.",
      "&",
      "! The rain comes down.",
      `? ${first} 0.6`,
      "! A burst of light.",
      "&",
      "! The light spreads everywhere.",
      `? ${second} 0.3`,
      "! Another burst.",
    ])
      expect(reader.take(line)).toBe(true);
    reader.end();
    expect(follows).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(read.map((block) => [block.guess.elementID, block.follows.length])).toEqual([
      [first, 1],
      [second, 0],
    ]);
    expect(read[0]?.draft.world.facts.storm).toBe("1");
  });

  test("stop at the limit, at a rejected one, and before any guess in a guess turn", () => {
    const follows: boolean[] = [];
    const reader = readGuesses({
      world,
      limit: 1,
      roundID: "root",
      alive: () => true,
      onGuess: () => undefined,
      onFollow: (_draft, continues) => follows.push(continues),
    });
    for (const line of ["&", "! One.", "&", "! Two.", "&", "! Three."]) reader.take(line);
    reader.end();
    expect(follows).toEqual([true, false]);
    const rejected: boolean[] = [];
    const broken = readGuesses({
      world,
      limit: 1,
      roundID: "root",
      alive: () => true,
      onGuess: () => undefined,
      onFollow: (_draft, continues) => rejected.push(continues),
    });
    for (const line of ["&", "&", "! Two."]) broken.take(line);
    broken.end();
    expect(rejected).toEqual([]);
    const read: GuessBlock[] = [];
    const guessTurn = readGuesses({
      world,
      limit: 1,
      roundID: "root",
      alive: () => true,
      onGuess: (block) => read.push(block),
    });
    for (const line of ["&", "! Orphaned.", `? ${first} 0.5`, "! Kept."]) guessTurn.take(line);
    guessTurn.end();
    expect(read.map((block) => block.draft.lines)).toEqual([["! Kept."]]);
  });

  test("a follow-up header settles the answer and says a follow-up comes next", async () => {
    const committed = await new Promise<{ lines: string[]; continues: boolean; taken: string[] }>(
      (resolve) => {
        const taken: string[] = [];
        let result: { lines: string[]; continues: boolean } | null = null;
        respond(
          { kind: "instruct", text: "rain" },
          {
            inputID: "a",
            world,
            reask: "unusable",
            reaskMs: 5000,
            signal: new AbortController().signal,
            stream: (_problems, _signal, onLine) => {
              for (const line of ["! Rain pours.", "&", "! Puddles spread."]) onLine(line);
              return Promise.resolve();
            },
            onProgress: () => undefined,
            onCommit: (draft, _stats, continues) => {
              result = { lines: draft.lines, continues };
              return {
                take: (line) => {
                  taken.push(line);
                  return true;
                },
                end: () => undefined,
              };
            },
            onWritten: () => {
              if (result !== null) resolve({ ...result, taken });
            },
            onFail: () => undefined,
          },
        );
      },
    );
    expect(committed).toEqual({
      lines: ["! Rain pours."],
      continues: true,
      taken: ["&", "! Puddles spread."],
    });
  });
});
