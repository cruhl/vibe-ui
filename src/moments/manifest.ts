import { z } from "zod";

const Box = z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() });

/** One element's box on a baked held frame, as Jev found it. */
export const BakedBox = z.object({
  elementID: z.string(),
  box: Box,
  confidence: z.number().nullable(),
  presence: z.number(),
});

/** A baked moment's held-frame checks. */
export const BakedChecks = z.object({
  presence: z.number(),
  introducedPresence: z.number().nullable(),
  lingering: z.number().nullable(),
  degradation: z.number().nullable(),
  seam: z.number().nullable(),
  passed: z.boolean(),
});

/**
 * One moment as baked: everything but the world (replayed from the root through the lines) and
 * the live-only fields. A written-only moment has no media, boxes or checks.
 */
export const BakedMoment = z.object({
  key: z.string(),
  parentKey: z.string().nullable(),
  input: z
    .object({
      elementID: z.string(),
      action: z.enum(["click", "type", "next"]),
      text: z.string().nullable(),
    })
    .nullable(),
  index: z.number(),
  label: z.string(),
  lines: z.array(z.string()),
  beat: z.string().nullable(),
  likelihood: z.number().nullable(),
  memory: z.object({ input: z.string(), response: z.string() }),
  stateHash: z.string(),
  prompt: z.string(),
  start: z.enum(["latent", "pinned", "fresh"]).nullable(),
  status: z.enum(["written", "ready"]),
  boxes: z.array(BakedBox).nullable(),
  checks: BakedChecks.nullable(),
  clip: z.string().nullable(),
  held: z.string().nullable(),
  clipBytes: z.number().nullable(),
  heldBytes: z.number().nullable(),
});
export type BakedMoment = z.infer<typeof BakedMoment>;

/** The hashes a tree was baked under, checked at load and by the bake script. */
export const BakeHashes = z.object({
  root: z.string(),
  instructions: z.string(),
  jevModel: z.string(),
});
export type BakeHashes = z.infer<typeof BakeHashes>;

/** A scenario's `moments/tree.json`: its baked moments in parent-first order. */
export const BakedTree = z.object({
  version: z.literal(1),
  scenario: z.string(),
  bakedAt: z.string(),
  hashes: BakeHashes,
  moments: z.array(BakedMoment),
});
export type BakedTree = z.infer<typeof BakedTree>;
