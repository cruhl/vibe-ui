import { record } from "../run-log/index.ts";

/** How long after a raw press an input can still claim it as its source. */
const pointerLinkMs = 1500;

/** What the raw input log reads from the page as each press lands. */
export interface RawInputSource {
  /** Where the video on screen is, so a press is logged as fractions of it. */
  videoRect: () => DOMRect | null;
  /** The input holding the lock, if any. */
  locked: () => string | null;
}

/** The raw input log of a page: stops it, and links an input to the press it came from. */
export interface RawInputLog {
  stop: () => void;
  /** The raw press an input came from, when one landed just before it and is not yet linked. */
  link: () => number | null;
}

function describe(target: Element | null): string | null {
  if (target === null) return null;
  const id = target.id === "" ? "" : `#${target.id}`;
  const classes = target.getAttribute("class");
  const classPart = classes === null ? "" : `.${classes.trim().split(/\s+/).join(".")}`;
  return `${target.tagName.toLowerCase()}${id}${classPart}`;
}

/**
 * Logs every raw pointer press and key press on the page, anywhere, with its point as fractions
 * of the video on screen, and logs `pointer_outcome` "no input" for a press nothing claimed.
 * Password fields are never logged.
 */
export function watchRawInput(source: RawInputSource): RawInputLog {
  let sequence = 0;
  let last: { pointerID: number; at: number; linked: boolean } | null = null;
  const onPointer = (event: PointerEvent) => {
    sequence++;
    const pointerID = sequence;
    const rect = source.videoRect();
    const inside =
      rect !== null &&
      rect.width > 0 &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    const target = event.target instanceof Element ? event.target : null;
    record("pointer_raw", {
      pointerID,
      clientX: Math.round(event.clientX),
      clientY: Math.round(event.clientY),
      x: inside ? Math.round(((event.clientX - rect.left) / rect.width) * 1000) / 1000 : null,
      y: inside ? Math.round(((event.clientY - rect.top) / rect.height) * 1000) / 1000 : null,
      button: event.button,
      target: describe(target),
      elementID: target?.closest("[data-element-id]")?.getAttribute("data-element-id") ?? null,
      locked: source.locked(),
    });
    const pending = { pointerID, at: performance.now(), linked: false };
    last = pending;
    setTimeout(() => {
      if (!pending.linked) record("pointer_outcome", { pointerID, outcome: "no input" });
    }, pointerLinkMs);
  };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === "password") return;
    record("key_raw", {
      key: event.key,
      code: event.code,
      target: target instanceof Element ? target.tagName.toLowerCase() : null,
      locked: source.locked(),
    });
  };
  window.addEventListener("pointerdown", onPointer, { capture: true });
  window.addEventListener("keydown", onKey, { capture: true });
  return {
    stop: () => {
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
    },
    link: () => {
      const press = last;
      if (press === null || press.linked || performance.now() - press.at > pointerLinkMs)
        return null;
      press.linked = true;
      return press.pointerID;
    },
  };
}
