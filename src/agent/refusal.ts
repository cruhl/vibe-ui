/** The model declined a turn: it streamed a refusal and no lines. `message` is its own words. */
export class RefusalError extends Error {
  constructor(refusal: string) {
    super(refusal);
    this.name = "RefusalError";
  }
}
