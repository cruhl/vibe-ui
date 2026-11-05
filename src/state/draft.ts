import { applyOp, type Op, type Parsed } from "./lines.ts";
import type { World } from "./world.ts";

const visibleOps = new Set<Op["op"]>([
  "change",
  "fact",
  "add",
  "remove",
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
 * replay all apply lines through this one class.
 */
export class Draft {
  readonly ops: Op[] = [];
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  readonly skipped: string[] = [];
  private readonly gone = new Set<string>();

  constructor(
    public world: World,
    private readonly forbidden: (op: Op) => string | null,
  ) {}

  /**
   * Applies one line; returns the reason it was rejected, or null. A line that asks for what is
   * already true, removing a thing that is not there or adding a thing that is already there
   * under the same parent, changes nothing and is skipped rather than rejected.
   */
  push(line: string, parsed: Parsed): string | null {
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
    const error = this.apply(parsed);
    if (error !== null) this.errors.push(`${line}: ${error}`);
    else this.lines.push(line);
    return error;
  }

  private apply(parsed: Parsed): string | null {
    if (!parsed.ok) return parsed.error;
    if (parsed.op.op === "guess") return "a guess header out of place";
    const word = this.forbidden(parsed.op);
    if (word !== null) return `the word ${word} is never allowed`;
    const applied = applyOp(this.world, parsed.op);
    if (!applied.ok) return applied.error;
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
