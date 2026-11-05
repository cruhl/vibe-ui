import { z } from "zod";
import { Control, World } from "./world.ts";

/** A thing the person can choose or type into, as the overlay and Jev see it. */
export const ViewElement = z.object({
  id: z.string(),
  kind: Control,
  label: z.string(),
  look: z.string(),
});
export type ViewElement = z.infer<typeof ViewElement>;

export const Fact = z.object({ key: z.string(), value: z.string() });
export type Fact = z.infer<typeof Fact>;

/**
 * The view every other domain reads: the world's name, its whole walk as one paragraph, the
 * things that can be chosen or typed into, its facts, and the world itself.
 */
export const View = z.object({
  name: z.string(),
  scene: z.string(),
  elements: z.array(ViewElement),
  facts: z.array(Fact),
  world: World,
});
export type View = z.infer<typeof View>;
