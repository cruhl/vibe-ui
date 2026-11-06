import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { boxAround } from "../boxes/index.ts";
import { pointAt, type JevConnection } from "../jev/index.ts";
import { projectEntity, viewOf } from "../projector/index.ts";
import { folderScenarios } from "../scenario/index.ts";
import { applyOp, parseLine, type Op, type World } from "../state/index.ts";
import { inputLabel, inputMemory } from "../turn/index.ts";
import { pointCandidates, pointInput, pointOutcome, seePoint } from "./point.ts";

vi.mock("../capture/index.ts", () => ({ captureFile: vi.fn() }));

const preset = folderScenarios.find((scenario) => scenario.id === "caveman-os");
if (preset === undefined) throw new Error("no caveman-os preset");

function run(world: World, lines: readonly string[]): { world: World; ops: Op[] } {
  let current = world;
  const ops: Op[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed.ok) throw new Error(parsed.error);
    const applied = applyOp(current, parsed.op);
    if (!applied.ok) throw new Error(applied.error);
    current = applied.world;
    ops.push(parsed.op);
  }
  return { world: current, ops };
}

const crowd = run(preset.world, [
  "+grunters world column.4 pick | a group of broad faced cave people carved in pale stone | GRUNTERS",
]).world;

const Sent = z.object({
  state: z.record(z.string(), z.string()),
  assets: z.record(z.string(), z.object({ data_base64: z.string() })),
  questions: z.object({
    point: z.object({
      type: z.string(),
      instructions: z.string(),
      criteria: z.record(z.string(), z.string()),
    }),
    field: z.object({ type: z.string(), instructions: z.string() }).optional(),
  }),
});

/** A Jev connection whose answer chooses `choice`, keeping every request it was sent. */
function fakeJev(choice: string | null, field = 0.1) {
  const sent: z.infer<typeof Sent>[] = [];
  const connection: JevConnection = {
    baseURL: "https://jev.test",
    key: "test",
    model: "jev-test",
    fetch: (_url, init) => {
      if (choice === null) return Promise.resolve(new Response("down", { status: 503 }));
      sent.push(Sent.parse(JSON.parse(typeof init?.body === "string" ? init.body : "")));
      return Promise.resolve(
        Response.json({
          model: "jev-test",
          answers: {
            point: { type: "choice", choice, confidence: 0.8, probabilities: { [choice]: 0.8 } },
            field: { type: "noul", noul: field },
          },
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    },
  };
  return { connection, sent };
}

describe("point clicks", () => {
  test("the crop around a point keeps its size and stays inside the frame", () => {
    const middle = boxAround({ x: 0.5, y: 0.5 }, 0.2, 0.4);
    expect(middle.left).toBeCloseTo(0.4);
    expect(middle.right).toBeCloseTo(0.6);
    expect(middle.top).toBeCloseTo(0.3);
    expect(middle.bottom).toBeCloseTo(0.7);
    const corner = boxAround({ x: 0.98, y: 0.01 }, 0.25, 0.44);
    expect(corner.left).toBeCloseTo(0.75);
    expect(corner.right).toBeCloseTo(1);
    expect(corner.top).toBe(0);
    expect(corner.bottom).toBeCloseTo(0.44);
  });

  test("Jev weighs every thing in the world and open background, on the frame and its crop", async () => {
    const candidates = pointCandidates(crowd);
    const index = candidates.findIndex((candidate) => candidate.id === "grunters");
    const { connection, sent } = fakeJev(`thing_${String(index)}`);
    const result = await pointAt(
      connection,
      "FRAME",
      "CROP",
      candidates,
      AbortSignal.timeout(1000),
    );
    expect(result.thingID).toBe("grunters");
    const request = sent[0];
    if (request === undefined) throw new Error("nothing sent");
    expect(Object.keys(request.state)).toEqual(["frame", "crop"]);
    expect(Object.values(request.assets).map((asset) => asset.data_base64)).toEqual([
      "FRAME",
      "CROP",
    ]);
    const criteria = request.questions.point.criteria;
    expect(Object.keys(criteria)).toHaveLength(candidates.length + 1);
    expect(criteria[`thing_${String(index)}`]).toContain("broad faced cave people");
    expect(criteria.open).toMatch(/background/i);
    expect(request.questions.point.instructions).toContain("`crop`");
  });

  test("open background reads as no thing", async () => {
    const { connection } = fakeJev("open");
    const result = await pointAt(
      connection,
      "FRAME",
      "CROP",
      pointCandidates(crowd),
      AbortSignal.timeout(1000),
    );
    expect(result.thingID).toBeNull();
  });

  test("the agent is told where the spot is and what Jev saw there", async () => {
    const candidates = pointCandidates(crowd);
    const index = candidates.findIndex((candidate) => candidate.id === "grunters");
    const { connection } = fakeJev(`thing_${String(index)}`);
    const outcome = await seePoint(
      connection,
      { frame: "FRAME", crop: "CROP" },
      { x: 0.704, y: 0.421 },
      viewOf(crowd),
      "abc",
    );
    expect(outcome).toEqual({
      kind: "point",
      input: {
        kind: "point",
        x: 0.7,
        y: 0.42,
        thingID: "grunters",
        label: "a group of broad faced cave people carved in pale stone",
      },
    });
    if (outcome?.kind !== "point") throw new Error("no input");
    const input = outcome.input;
    expect(inputMemory(input)).toBe(
      "click a spot on a group of broad faced cave people carved in pale stone",
    );
    expect(inputLabel(input)).toBe(input.label);
  });

  test("a thing Jev names that is gone, or no thing, is open background", () => {
    expect(pointInput({ x: 0.1, y: 0.2 }, "nobody", crowd)).toMatchObject({
      thingID: null,
      label: "open background",
    });
    expect(pointInput({ x: 0.1, y: 0.2 }, null, crowd).thingID).toBeNull();
  });

  test("a point on an input opens typing on it and is never an action", () => {
    const typing = run(crowd, [
      "+carve-box world column.3 input | a wide plain flat slab for carving words | CARVE",
    ]).world;
    const outcome = pointOutcome(
      { x: 0.4, y: 0.6 },
      { thingID: "carve-box", field: 0 },
      viewOf(typing),
    );
    expect(outcome).toEqual({
      kind: "typing",
      target: { elementID: "carve-box", thingID: "carve-box", label: "CARVE", x: 0.4, y: 0.6 },
    });
  });

  test("a spot Jev sees as a field opens typing there even with no input declared", async () => {
    const { connection, sent } = fakeJev("open", 0.9);
    const outcome = await seePoint(
      connection,
      { frame: "FRAME", crop: "CROP" },
      { x: 0.5, y: 0.8 },
      viewOf(crowd),
      "abc",
    );
    expect(outcome).toEqual({
      kind: "typing",
      target: { elementID: null, thingID: null, label: "open background", x: 0.5, y: 0.8 },
    });
    expect(sent[0]?.questions.field?.instructions).toMatch(/typing/i);
    const grunters = pointOutcome(
      { x: 0.7, y: 0.4 },
      { thingID: "grunters", field: 0.8 },
      viewOf(crowd),
    );
    expect(grunters).toMatchObject({
      kind: "typing",
      target: { elementID: null, thingID: "grunters" },
    });
    const picked = pointOutcome(
      { x: 0.7, y: 0.4 },
      { thingID: "grunters", field: 0.2 },
      viewOf(crowd),
    );
    expect(picked.kind).toBe("point");
  });

  test("Jev failing drops the point", async () => {
    const { connection } = fakeJev(null);
    expect(
      await seePoint(
        connection,
        { frame: "F", crop: "C" },
        { x: 0.5, y: 0.5 },
        viewOf(crowd),
        "abc",
      ),
    ).toBeNull();
  });

  test("the clip approaches the pick the agent made of the spot, or opens on the change", () => {
    const point = pointInput({ x: 0.7, y: 0.42 }, "grunters", crowd);
    const member = run(crowd, [
      "+grunter-tall grunters column.4 pick | a tall carved caveman with a braided beard | | grinning wide",
      "! the tall caveman steps forward and thumps his chest",
    ]);
    const filmed = projectEntity(member.world, point, crowd, member.ops).prompt;
    expect(filmed).toContain("tall carved caveman with a braided beard");
    expect(filmed).toContain(
      "In the first half second, the tall carved caveman with a braided beard thumps",
    );
    const open = pointInput({ x: 0.5, y: 0.2 }, null, crowd);
    const woken = run(crowd, ["~wallpaper its painted mammoths stomping across the stone"]);
    const awake = projectEntity(woken.world, open, crowd, woken.ops).prompt;
    expect(awake).toContain("Right from the first moment");
  });
});
