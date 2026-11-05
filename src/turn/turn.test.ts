import { describe, expect, test } from "vitest";
import { folderScenarios } from "../scenario/index.ts";
import { viewOf } from "../projector/index.ts";
import { parseLine } from "../state/index.ts";
import { draftProblems, inputMemory, newDraft, usableDraft } from "./draft.ts";
import { readGuesses, type GuessBlock } from "./guesses.ts";

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
