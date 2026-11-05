/** Recorded footage and timings a mock session replays in place of its drawn placeholder. */
export interface MockReplay {
  /** The measured build seconds for a prompt, or null to use the measured list. */
  buildSeconds: (prompt: string) => number | null;
  /** The footage to play for a clip, by its prompt and how many clips this page has played. */
  footage: (prompt: string, playIndex: number) => HTMLVideoElement | null;
}

let replay: MockReplay | null = null;

/** Makes every mock session in this page replay recorded footage and build times. */
export function setMockReplay(next: MockReplay | null): void {
  replay = next;
}

/** The replay mock sessions play, or null for their drawn placeholder. */
export function mockReplay(): MockReplay | null {
  return replay;
}
