import { answers, type Moment, type MomentInput } from "./moment.ts";

/**
 * The moments ahead of the stage: one tree rooted at the moment on screen. Every node's parent is
 * in the tree; re-rooting prunes everything outside the new root's subtree at once.
 */
export class MomentTree {
  private readonly nodes = new Map<string, Moment>();
  private readonly kids = new Map<string, Moment[]>();
  private rootKey: string | null = null;

  /** The moment on screen, or null before the opening is written. */
  get root(): Moment | null {
    return this.rootKey === null ? null : (this.nodes.get(this.rootKey) ?? null);
  }

  /** Starts over from a new root; every earlier moment is pruned and returned. */
  plant(root: Moment): Moment[] {
    const pruned = [...this.nodes.values()].filter((node) => node !== root);
    this.nodes.clear();
    this.kids.clear();
    this.nodes.set(root.key, root);
    this.rootKey = root.key;
    return pruned;
  }

  /** The moment under a key, or null. */
  get(key: string): Moment | null {
    return this.nodes.get(key) ?? null;
  }

  /** Whether this very moment is still in the tree, not pruned or replaced. */
  holds(moment: Moment): boolean {
    return this.nodes.get(moment.key) === moment;
  }

  /**
   * Adds a moment under its parent; false when its parent is not in the tree or a moment with the
   * same key, or answering the same input, is already there.
   */
  add(moment: Moment): boolean {
    const parentKey = moment.parentKey;
    if (parentKey === null || !this.nodes.has(parentKey) || this.nodes.has(moment.key))
      return false;
    const siblings = this.kids.get(parentKey) ?? [];
    const input = moment.input;
    if (input !== null && siblings.some((sibling) => answers(sibling, input))) return false;
    this.nodes.set(moment.key, moment);
    this.kids.set(parentKey, [...siblings, moment]);
    return true;
  }

  /** A moment's children in the agent's order. */
  children(moment: Moment): Moment[] {
    return [...(this.kids.get(moment.key) ?? [])].sort(
      (first, second) => first.index - second.index,
    );
  }

  /** The root's child that answers an input, or null. */
  findMatch(input: MomentInput): Moment | null {
    const root = this.root;
    if (root === null) return null;
    return this.children(root).find((child) => answers(child, input)) ?? null;
  }

  /** Steps from the root to a moment: 0 for the root, null for a moment not in the tree. */
  depth(moment: Moment): number | null {
    if (!this.holds(moment)) return null;
    let depth = 0;
    let current: Moment | null = moment;
    while (current !== null && current.key !== this.rootKey) {
      depth++;
      current = current.parentKey === null ? null : this.get(current.parentKey);
    }
    return current === null ? null : depth;
  }

  /**
   * How likely the person reaches a moment from the one on stage: the product of the likelihoods on the
   * path from the root, each unscored step counted as an even share among its siblings.
   */
  pathProbability(moment: Moment): number {
    let probability = 1;
    let current: Moment | null = moment;
    while (current !== null && current.key !== this.rootKey) {
      const parent: Moment | null = current.parentKey === null ? null : this.get(current.parentKey);
      const siblings = parent === null ? 1 : Math.max(1, this.children(parent).length);
      probability *= current.likelihood ?? 1 / siblings;
      current = parent;
    }
    return probability;
  }

  /** A moment and everything below it, parents first. */
  subtree(moment: Moment): Moment[] {
    const found: Moment[] = [];
    const visit = (node: Moment) => {
      found.push(node);
      for (const child of this.children(node)) visit(child);
    };
    if (this.holds(moment)) visit(moment);
    return found;
  }

  /** Every moment in the tree, parents first. */
  all(): Moment[] {
    const root = this.root;
    return root === null ? [] : this.subtree(root);
  }

  /**
   * Removes a moment that is not the root and everything below it, returned parent first; a
   * moment not in the tree, or the root, removes nothing.
   */
  cut(moment: Moment): Moment[] {
    if (!this.holds(moment) || moment.key === this.rootKey) return [];
    const removed = this.subtree(moment);
    for (const node of removed) {
      this.nodes.delete(node.key);
      this.kids.delete(node.key);
    }
    const parentKey = moment.parentKey;
    if (parentKey !== null)
      this.kids.set(
        parentKey,
        (this.kids.get(parentKey) ?? []).filter((sibling) => sibling !== moment),
      );
    return removed;
  }

  /**
   * Makes a moment in the tree the root and prunes everything outside its subtree, returned in
   * parent-first order. A moment not in the tree changes nothing and prunes nothing.
   */
  reRoot(moment: Moment): Moment[] {
    if (!this.holds(moment)) return [];
    const kept = new Set(this.subtree(moment));
    const pruned = this.all().filter((node) => !kept.has(node));
    for (const node of pruned) {
      this.nodes.delete(node.key);
      this.kids.delete(node.key);
    }
    this.rootKey = moment.key;
    return pruned;
  }
}
