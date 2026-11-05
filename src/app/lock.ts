/**
 * The input lock: which input is being answered, its one deadline counted from the click, and the
 * last input refused while it waits, kept to be replayed the moment the lock lifts. A missed
 * deadline calls `onMiss` once with the locked input; the owner fails it and unlocks.
 */
export class InputLock<Held> {
  private current: {
    inputID: string;
    milliseconds: number;
    remainingMs: number;
    armedAt: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private held: Held | null = null;

  constructor(
    private readonly onMiss: (inputID: string, milliseconds: number) => void,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** The input being answered, or null when input is open. */
  get inputID(): string | null {
    return this.current?.inputID ?? null;
  }

  /** Locks on an input with a deadline in milliseconds from now, replacing any earlier lock. */
  lock(inputID: string, milliseconds: number): void {
    this.clearTimer();
    this.current = { inputID, milliseconds, remainingMs: milliseconds, armedAt: 0, timer: null };
    this.arm();
  }

  /** Lifts the lock and stops its deadline; returns the input it was on, or null. */
  unlock(): string | null {
    const inputID = this.inputID;
    this.clearTimer();
    this.current = null;
    return inputID;
  }

  /** Stops the deadline clock, keeping the time left, while the session is paused. */
  suspend(): void {
    const current = this.current;
    if (current?.timer == null) return;
    current.remainingMs = Math.max(0, current.remainingMs - (this.clock() - current.armedAt));
    this.clearTimer();
  }

  /** Starts the deadline clock again with the time that was left. */
  resume(): void {
    if (this.current !== null && this.current.timer === null) this.arm();
  }

  /** Keeps an input refused during the lock; returns the earlier kept input it replaces. */
  hold(input: Held): Held | null {
    const replaced = this.held;
    this.held = input;
    return replaced;
  }

  /** Takes the kept input out, to be replayed. */
  takeHeld(): Held | null {
    const held = this.held;
    this.held = null;
    return held;
  }

  private arm(): void {
    const current = this.current;
    if (current === null) return;
    current.armedAt = this.clock();
    current.timer = setTimeout(() => {
      current.timer = null;
      if (this.current === current) this.onMiss(current.inputID, current.milliseconds);
    }, current.remainingMs);
  }

  private clearTimer(): void {
    if (this.current?.timer != null) clearTimeout(this.current.timer);
    if (this.current !== null) this.current.timer = null;
  }
}
