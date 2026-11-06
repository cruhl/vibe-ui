import { applyOp, crowding, type Op, type Parsed } from "./lines.ts";
import type { World } from "./world.ts";

const visibleOps = new Set<Op["op"]>([
  "change",
  "fact",
  "add",
  "remove",
  "clear",
  "beat",
  "gag",
  "climb",
  "say",
  "film",
]);

/**
 * A world being built from agent lines: each line is parsed, checked by `forbidden` and applied,
 * or rejected with its reason. Removing something already removed in the same draft, such as a
 * room's insides after the room, is ignored. The agent path, the moment validator and the bake
 * replay all apply lines through this one class. Only a `limited` draft, the live agent's, holds
 * the view to `viewLimits`: an add that would crowd it is dropped rather than rejected, with its
 * reason kept in `crowded`, and so is every later line about the thing it would have added.
 */
export class Draft {
  readonly ops: Op[] = [];
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  readonly skipped: string[] = [];
  /** The add lines dropped because they would have crowded the view, each with its reason. */
  readonly crowded: string[] = [];
  private readonly gone = new Set<string>();
  private readonly dropped = new Set<string>();

  constructor(
    public world: World,
    private readonly forbidden: (op: Op) => string | null,
    private readonly limited = false,
  ) {}

  /**
   * Applies one line; returns the reason it was rejected, or null. A line that asks for what is
   * already true, removing a thing that is not there or adding a thing that is already there
   * under the same parent, changes nothing and is skipped rather than rejected.
   */
  push(line: string, parsed: Parsed): string | null {
    if (parsed.ok && this.touchesDropped(parsed.op)) {
      if (parsed.op.op === "add") this.dropped.add(parsed.op.placement.id);
      this.skipped.push(line);
      return null;
    }
    if (parsed.ok && parsed.op.op === "remove" && this.gone.has(parsed.op.id)) return null;
    if (parsed.ok && parsed.op.op === "remove" && this.world.entities[parsed.op.id] === undefined) {
      this.skipped.push(line);
      return null;
    }
    if (
      parsed.ok &&
      parsed.op.op === "add" &&
      this.world.entities[parsed.op.placement.id] !== undefined &&
      (parsed.op.placement.parent === undefined ||
        this.world.entities[parsed.op.placement.id]?.parent === parsed.op.placement.parent)
    ) {
      this.skipped.push(line);
      return null;
    }
    const crowded = this.crowded.length;
    const error = this.apply(line, parsed);
    if (error !== null) this.errors.push(`${line}: ${error}`);
    else if (this.crowded.length === crowded) this.lines.push(line);
    return error;
  }

  private touchesDropped(op: Op): boolean {
    switch (op.op) {
      case "add":
        return (
          op.placement.parent !== null &&
          op.placement.parent !== undefined &&
          this.dropped.has(op.placement.parent)
        );
      case "change":
      case "remove":
      case "say":
        return this.dropped.has(op.id);
      default:
        return false;
    }
  }

  private apply(line: string, parsed: Parsed): string | null {
    if (!parsed.ok) return parsed.error;
    if (parsed.op.op === "guess") return "a guess header out of place";
    if (parsed.op.op === "follow") return "a follow-up header out of place";
    const word = this.forbidden(parsed.op);
    if (word !== null) return `the word ${word} is never allowed`;
    const applied = applyOp(this.world, parsed.op);
    if (!applied.ok) return applied.error;
    const crowd =
      this.limited && parsed.op.op === "add" ? crowding(this.world, applied.world) : null;
    if (crowd !== null) {
      this.crowded.push(`${line}: ${crowd}`);
      if (parsed.op.op === "add") this.dropped.add(parsed.op.placement.id);
      return null;
    }
    for (const id of Object.keys(this.world.entities))
      if (applied.world.entities[id] === undefined) this.gone.add(id);
    this.world = applied.world;
    this.ops.push(parsed.op);
    return null;
  }

  /** Whether the kept lines change anything a viewer would see. */
  visible(): boolean {
    return this.ops.some((op) => visibleOps.has(op.op));
  }
}
