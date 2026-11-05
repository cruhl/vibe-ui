import { describe, expect, test } from "vitest";
import { Memory, memoryBudget } from "./memory.ts";

describe("Memory", () => {
  test("reads the last entries as lines, oldest first", () => {
    const memory = new Memory();
    for (let i = 0; i < 5; i++) memory.append({ t: i, kind: "input", text: `click ${i}` });
    memory.append({ t: 5.25, kind: "response", text: "the door opens" });
    expect(memory.tail(2)).toEqual(["4.0s input: click 4", "5.3s response: the door opens"]);
    expect(memory.tail(10)).toHaveLength(6);
  });

  test("keeps every direction verbatim while routine history is compacted", async () => {
    const folded: string[][] = [];
    const memory = new Memory((story, lines) => {
      folded.push([...lines]);
      return Promise.resolve(`${story ?? ""} folded ${lines.length}`.trim());
    });
    memory.append({ t: 0, kind: "direction", text: "told you: make it a submarine" });
    const long = "x".repeat(200);
    for (let i = 1; i < 40; i++) {
      memory.append({ t: i, kind: "response", text: long });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const context = memory.context();
    expect(context.directions).toEqual(["1. told you: make it a submarine"]);
    expect(folded.length).toBeGreaterThan(0);
    expect(context.story).toMatch(/^folded/);
    expect(context.recent.join("\n").length).toBeLessThanOrEqual(memoryBudget.compactAt + 300);
  });
});
