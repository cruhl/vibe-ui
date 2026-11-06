import { describe, expect, test } from "vitest";
import { folderScenarios } from "../scenario/index.ts";
import { forbiddenInOp, projectEntity, viewOf } from "../projector/index.ts";
import { Draft, hashWorld, parseLine } from "../state/index.ts";
import { checkTree } from "./load.ts";
import type { BakedMoment, BakedTree } from "./manifest.ts";
import { momentKey } from "./moment.ts";

const found = folderScenarios[0];
if (found === undefined) throw new Error("no scenario folder");
const first = found;
const world = first.world;
const picked = viewOf(world).elements[0];
if (picked === undefined) throw new Error("no pick in the first scenario");
const element = picked;
const hashes = { root: "root-key", instructions: "i1", jevModel: "jev-1" };

function baked(): BakedTree {
  const lines = ["! a door creaks open and a cold wind rushes through the room"];
  const draft = new Draft(world, forbiddenInOp);
  for (const line of lines) draft.push(line, parseLine(line));
  const input = { elementID: element.id, action: "click" as const, text: null };
  const base: Omit<BakedMoment, "key" | "parentKey" | "input" | "lines" | "stateHash" | "prompt"> =
    {
      index: 0,
      label: element.label,
      beat: null,
      likelihood: 0.5,
      memory: { input: `click ${element.label}`, response: "" },
      start: "pinned",
      status: "ready",
      boxes: [],
      checks: null,
      clip: "a.mp4",
      held: "a.jpg",
      clipBytes: 1,
      heldBytes: 1,
    };
  return {
    version: 1,
    scenario: first.id,
    bakedAt: "2026-11-04T00:00:00Z",
    hashes,
    moments: [
      {
        ...base,
        key: "root-key",
        parentKey: null,
        input: null,
        lines: [],
        stateHash: hashWorld(world),
        prompt: "opening",
      },
      {
        ...base,
        key: momentKey("root-key", input, draft.lines),
        parentKey: "root-key",
        input,
        lines: draft.lines,
        stateHash: hashWorld(draft.world),
        prompt: projectEntity(
          draft.world,
          { kind: "click", elementID: element.id, label: element.label },
          world,
          draft.ops,
        ).prompt,
      },
    ],
  };
}

describe("checking a baked tree", () => {
  test("keeps every moment that replays to the same state and prompt", () => {
    const check = checkTree(baked(), world, hashes);
    expect(check.rootStale).toBe(false);
    expect(check.stale).toEqual([]);
    expect(check.moments).toHaveLength(2);
    expect(check.behind).toBe(false);
  });

  test("a changed root key makes the whole tree stale", () => {
    const check = checkTree(baked(), world, { ...hashes, root: "other" });
    expect(check.rootStale).toBe(true);
    expect(check.moments).toEqual([]);
  });

  test("a changed prompt or lines drops the moment; changed instructions mark it behind", () => {
    const tree = baked();
    const child = tree.moments[1];
    if (child === undefined) throw new Error("no child");
    const edited = { ...tree, moments: [tree.moments[0], { ...child, prompt: "other" }] };
    const prompt = checkTree(edited, world, { ...hashes, instructions: "i2" });
    expect(prompt.moments).toHaveLength(1);
    expect(prompt.stale[0]).toContain("prompt");
    expect(prompt.behind).toBe(true);
    const lines = { ...tree, moments: [tree.moments[0], { ...child, lines: ["+bad"] }] };
    expect(checkTree(lines, world, hashes).stale[0]).toContain("key");
  });

  test("an unreadable tree is stale as a whole", () => {
    expect(checkTree({ version: 2 }, world, hashes).rootStale).toBe(true);
  });
});
