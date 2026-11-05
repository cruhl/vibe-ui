import { record } from "./log.ts";

/** A named external call that missed its deadline. */
export class DeadlineError extends Error {
  constructor(
    readonly callName: string,
    readonly milliseconds: number,
  ) {
    super(`${callName} missed its ${milliseconds} ms deadline`);
  }
}

/**
 * Runs an external call with a deadline. On a miss the signal aborts, `deadline_missed` is logged
 * by name, and the promise rejects with a DeadlineError instead of hanging.
 */
export function withDeadline<T>(
  callName: string,
  milliseconds: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      record("deadline_missed", { call: callName, milliseconds });
      controller.abort();
      reject(new DeadlineError(callName, milliseconds));
    }, milliseconds);
    run(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Runs a call, and once more if it fails; logs `retry` with the first failure. */
export async function retryOnce<T>(callName: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    record("retry", { call: callName, reason: String(error) });
    return run();
  }
}
