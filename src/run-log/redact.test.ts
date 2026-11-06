import { describe, expect, test } from "vitest";
import { redact } from "./redact.ts";

describe("redact", () => {
  test("replaces given secrets and anything key or token shaped", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";
    const text = `own mykey-1234567890 openai sk-proj-abcdefghijklmnopqrstuvwxyz token ${jwt} header Bearer abcdefghijklmnop`;
    const scrubbed = redact(text, ["mykey-1234567890", "short"]);
    expect(scrubbed).toBe("own [redacted] openai [redacted] token [redacted] header [redacted]");
  });

  test("leaves ordinary text and short values alone", () => {
    expect(redact("a clip of 8 seconds", ["short"])).toBe("a clip of 8 seconds");
  });
});
