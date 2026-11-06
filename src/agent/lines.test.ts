import { describe, expect, test } from "vitest";
import { folderScenarios } from "../scenario/index.ts";
import { forbiddenWords } from "../projector/index.ts";
import { lineLimits } from "../state/index.ts";
import { linesContext, linesInstructions } from "./lines.ts";
import { splitGlued } from "./split.ts";

describe("splitGlued", () => {
  test("splits an op glued after a sentence end", () => {
    expect(splitGlued("> Stone scrapes softly.? make-fire 0.8")).toEqual([
      "> Stone scrapes softly.",
      "? make-fire 0.8",
    ]);
    expect(
      splitGlued("> A soft stone scrape.+fire-window world center | a hide | FIRE.EXE"),
    ).toEqual(["> A soft stone scrape.", "+fire-window world center | a hide | FIRE.EXE"]);
  });

  test("leaves dotted labels and fact names whole", () => {
    expect(splitGlued("+fire-window world center | a hide | FIRE.EXE")).toHaveLength(1);
    expect(splitGlued("~counter | CUPS $cups.sold")).toHaveLength(1);
  });
});

describe("linesInstructions", () => {
  test("states the limits and forbidden words the code enforces, with every slot filled", () => {
    const preset = folderScenarios[0];
    if (preset === undefined) throw new Error("no preset");
    const instructions = linesInstructions(preset.premise, preset.world, 3);
    expect(instructions).toContain(`at most ${lineLimits.look} words`);
    expect(instructions).toContain(`one to ${lineLimits.printed} words, written exactly`);
    expect(instructions).toContain(forbiddenWords.negatives.join(", "));
    expect(instructions).toContain(forbiddenWords.pointer.join(", "));
    expect(instructions).toContain(preset.premise.trim());
    expect(instructions).not.toMatch(
      /\{(lookWords|beatWords|sayWords|printedWords|negatives|pointerWords|premise|frame|still|approach|settle|places|ladder)\}/,
    );
  });
});

describe("linesContext", () => {
  const world = folderScenarios[0]?.world;
  if (world === undefined) throw new Error("no preset");
  const memory = { directions: [], story: null, recent: [] };
  test("a click on no box says where the spot is and what Jev saw there", () => {
    const on = { kind: "point", x: 0.7, y: 0.42, thingID: "grunters", label: "a crowd" } as const;
    expect(linesContext(world, memory, { kind: "respond", input: on, problems: [] })).toContain(
      "input: picked a spot 70% across and 42% down the picture, on grunters (a crowd)",
    );
    const open = { ...on, thingID: null, label: "open background" };
    expect(linesContext(world, memory, { kind: "respond", input: open, problems: [] })).toContain(
      "input: picked a spot 70% across and 42% down the picture, on open background",
    );
  });
});
