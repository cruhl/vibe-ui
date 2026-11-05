/**
 * One remembered moment: what the person did, what they said in their own words (a direction:
 * a message to the world or text they typed), or what the world became.
 */
export interface MemoryEntry {
  t: number;
  kind: "input" | "direction" | "response";
  text: string;
}

/** What the agent reads of the session's memory each turn. */
export interface MemoryContext {
  /** Every direction the person gave, verbatim and numbered, oldest first; never dropped. */
  directions: string[];
  /** The agent's own compaction of the routine history older than `recent`, or null. */
  story: string | null;
  /** The routine history since the story, oldest first. */
  recent: string[];
}

/** Folds older routine history into the story so far; resolves to the new story. */
export type Compactor = (story: string | null, lines: readonly string[]) => Promise<string>;

/**
 * Character budgets of the routine history: past `compactAt` the oldest entries are folded into
 * the story until about `keep` remain; past `ceiling` (compaction failing) the oldest are dropped.
 */
export const memoryBudget = { compactAt: 4000, keep: 1600, ceiling: 9000 } as const;

const line = (entry: MemoryEntry) => `${entry.t.toFixed(1)}s ${entry.kind}: ${entry.text}`;
const size = (entries: readonly MemoryEntry[]) =>
  entries.reduce((total, entry) => total + line(entry).length + 1, 0);

/**
 * The session's memory. The person's directions are kept whole for the whole session; routine
 * history is kept as written until it outgrows its budget, then the agent compacts its oldest part
 * into a story so far, off the click path. Jev reads the recent end.
 */
export class Memory {
  private readonly entries: MemoryEntry[] = [];
  private readonly said: string[] = [];
  private story: string | null = null;
  private compacting = false;

  constructor(private readonly compactor: Compactor | null = null) {}

  append(entry: MemoryEntry): void {
    this.entries.push(entry);
    if (entry.kind === "direction") this.said.push(entry.text);
    this.compact();
  }

  /** The last `count` entries as lines, oldest first. */
  tail(count: number): string[] {
    return this.entries.slice(-count).map(line);
  }

  context(): MemoryContext {
    return {
      directions: this.said.map((text, index) => `${index + 1}. ${text}`),
      story: this.story,
      recent: this.entries.map(line),
    };
  }

  private compact(): void {
    while (size(this.entries) > memoryBudget.ceiling) this.entries.shift();
    if (this.compactor === null || this.compacting || size(this.entries) <= memoryBudget.compactAt)
      return;
    let count = 0;
    while (count < this.entries.length - 2 && size(this.entries.slice(count)) > memoryBudget.keep)
      count++;
    const folded = this.entries.slice(0, count);
    this.compacting = true;
    void this.compactor(this.story, folded.map(line))
      .then((story) => {
        if (story.trim() === "") return;
        this.story = story.trim();
        const gone = new Set(folded);
        const kept = this.entries.filter((entry) => !gone.has(entry));
        this.entries.splice(0, this.entries.length, ...kept);
      })
      .catch(() => undefined)
      .finally(() => {
        this.compacting = false;
      });
  }
}
