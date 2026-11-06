/**
 * How long one background build may take: about three times the measured 4 to 5 s for a
 * 5.875 s clip.
 */
export const buildDeadlineMs = 15000;

/** A background build that missed its deadline, and whether its session looks wedged. */
export interface BuildMiss {
  clipID: string;
  slot: number;
  milliseconds: number;
  /** The session finished no build within the deadline while this one waited on it. */
  wedged: boolean;
}

/**
 * The deadline on every background build: each queued clip gets `buildDeadlineMs` for itself
 * and for every build queued ahead of it on its session, and a miss calls `onMiss` once. A session
 * counts as wedged when it finished no build within `buildDeadlineMs` of the miss, so a long queue
 * still moving is only slow.
 */
export class BuildWatch {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly progressAt = new Map<number, number>();

  constructor(
    private readonly onMiss: (miss: BuildMiss) => void,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** Watches a clip just queued on `slot` behind `ahead` builds already outstanding there. */
  watch(clipID: string, slot: number, ahead: number): void {
    this.settle(clipID);
    if (!this.progressAt.has(slot)) this.progressed(slot);
    const milliseconds = buildDeadlineMs * (ahead + 1);
    this.timers.set(
      clipID,
      setTimeout(() => {
        this.timers.delete(clipID);
        const wedged = this.clock() - (this.progressAt.get(slot) ?? 0) >= buildDeadlineMs;
        this.onMiss({ clipID, slot, milliseconds, wedged });
      }, milliseconds),
    );
  }

  /** A clip was built, failed or popped: its deadline stops. */
  settle(clipID: string): void {
    const timer = this.timers.get(clipID);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(clipID);
  }

  /** A session finished a build or started fresh, so it is not wedged now. */
  progressed(slot: number): void {
    this.progressAt.set(slot, this.clock());
  }

  /** Whether a clip's deadline is still running. */
  watching(clipID: string): boolean {
    return this.timers.has(clipID);
  }

  /** Stops every deadline, for a reconnect. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.progressAt.clear();
  }
}
