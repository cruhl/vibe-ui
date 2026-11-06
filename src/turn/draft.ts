import type { AgentInput } from "../agent/index.ts";
import { forbiddenInOp, viewOf } from "../projector/index.ts";
import { Draft, unresolvedFacts, type World } from "../state/index.ts";

/**
 * A draft of a world that applies the live agent's lines under the projector's forbidden words and
 * the ceiling on things in view.
 */
export const newDraft = (world: World) => new Draft(world, forbiddenInOp, true);

/**
 * Whether a draft can be filmed: it changes something visible, prints no missing fact and keeps
 * at least one pick. Its rejected lines are simply left out.
 */
export function usableDraft(draft: Draft): boolean {
  return (
    draft.visible() &&
    unresolvedFacts(draft.world).length === 0 &&
    viewOf(draft.world).elements.length > 0
  );
}

/** Every problem of a draft, as the re-ask lists them to the agent. */
export function draftProblems(draft: Draft): string[] {
  return [
    ...draft.errors,
    ...draft.crowded,
    ...(viewOf(draft.world).elements.length === 0 ? ["the world must keep at least one pick"] : []),
    ...(draft.visible() ? [] : ["the lines changed nothing visible"]),
    ...unresolvedFacts(draft.world).map((key) => `$${key} prints a fact that does not exist`),
  ];
}

/** The memory entry an input appends, the same live and from a baked moment. */
export function inputMemory(input: AgentInput): string {
  return input.kind === "type" || input.kind === "field"
    ? `typed ${input.text} into ${input.label}`
    : input.kind === "instruct"
      ? `told you: ${input.text}`
      : input.kind === "start"
        ? "start"
        : input.kind === "point"
          ? `click a spot on ${input.label}`
          : `click ${input.label}`;
}

/** The label an input shows in the timeline. */
export function inputLabel(input: AgentInput): string {
  return input.kind === "start" ? "start" : input.kind === "instruct" ? input.text : input.label;
}
