const limitMs = 6000;

/**
 * Ends the run, waits until every session it opened has closed (its disconnect resolved and its
 * terminate answered), at most six seconds, then loads `url` in place of this page, so the
 * scenario in the URL is always a link that opens straight into it.
 */
export function shutDownThen(end: () => Promise<void>, running: boolean, url: string): void {
  const open = () => {
    location.replace(url);
  };
  if (!running) {
    open();
    return;
  }
  void Promise.race([
    end(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, limitMs);
    }),
  ]).then(open, open);
}
