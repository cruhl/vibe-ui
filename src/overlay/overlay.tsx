import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { boxAt, type Point } from "../boxes/index.ts";
import type { Box, ElementBox } from "../jev/index.ts";
import { eventSeconds, record } from "../run-log/index.ts";
import type { ViewElement } from "../state/index.ts";

interface Props {
  elements: readonly ViewElement[];
  boxes: readonly ElementBox[];
  enabled: boolean;
  /** Whether the last input is still being answered; presses are held until it is. */
  locked: boolean;
  debug?: boolean;
  presenceThreshold?: number;
  onClick: (element: ViewElement) => void;
  onType: (element: ViewElement, text: string) => void;
  /**
   * A click as a point, fractions of the frame; when given, the controller resolves the element,
   * and a click on no box comes here too, for the controller to read what is there.
   */
  onPoint?: (x: number, y: number) => void;
  /** A press landed on an element's box, at `clickT` session seconds, before any click resolves. */
  onPress: (press: { elementID: string; box: Box; clickT: number }) => void;
  /** A press or typed text arrived while input is locked or off. */
  onRefused: () => void;
  /** The pointer entered a box that takes a click (its id), or left every box (null). */
  onHover?: (elementID: string | null) => void;
}

interface Ripple {
  id: number;
  x: number;
  y: number;
}

function InputBox({ element, onType }: { element: ViewElement; onType: Props["onType"] }) {
  const [text, setText] = useState("");
  return (
    <input
      className="overlay-input"
      aria-label={element.label}
      placeholder="Type, then press Enter"
      enterKeyHint="send"
      autoComplete="off"
      spellCheck={false}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || text.trim() === "") return;
        onType(element, text);
        setText("");
      }}
    />
  );
}

const hasArea = (found: ElementBox) =>
  found.box.right > found.box.left && found.box.bottom > found.box.top;

/**
 * The click layer over the video. Every press is resolved by its point against the live boxes,
 * smallest box first, in one handler, and logged with its point and outcome; a press on no box
 * goes to the controller as a point, which reads what is there. A pressed element
 * reacts on the video at once; while the last input is still being answered a press nudges the
 * busy state and still goes to the controller, which keeps the last one and replays it when the
 * lock lifts, and hover and pointer cues are off, so the lock shows. Each element still has its
 * own labelled button for keyboards and drivers.
 */
export function Overlay({
  elements,
  boxes,
  enabled,
  locked,
  debug = false,
  presenceThreshold = 0.5,
  onClick,
  onType,
  onPoint,
  onPress,
  onRefused,
  onHover,
}: Props) {
  const byID = new Map(elements.map((element) => [element.id, element]));
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [pressed, setPressed] = useState<Point | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const nextRipple = useRef(0);
  const [wasLocked, setWasLocked] = useState(locked);
  if (wasLocked !== locked) {
    setWasLocked(locked);
    if (!locked) setPressed(null);
  }
  const live = boxes.filter(
    (found) =>
      byID.has(found.elementID) && hasArea(found) && (debug || found.presence >= presenceThreshold),
  );
  const clickable = enabled && !locked;
  const hover = (id: string | null) => {
    if (id === hovered) return;
    if (hovered !== null) record("box_hover", { elementID: hovered, phase: "leave" });
    if (id !== null) record("box_hover", { elementID: id, phase: "enter" });
    setHovered(id);
    onHover?.(id === null || byID.get(id)?.kind === "input" ? null : id);
  };
  const addRipple = (point: Point) => {
    nextRipple.current += 1;
    const id = nextRipple.current;
    setRipples((current) => [...current, { id, x: point.x * 100, y: point.y * 100 }]);
  };
  const pointOf = (event: PointerEvent | MouseEvent, surface: HTMLElement): Point | null => {
    const bounds = surface.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  };
  return (
    <div
      className={`overlay ${clickable ? "overlay-enabled" : "overlay-waiting"}`}
      data-debug={debug}
      data-locked={locked}
      onPointerMove={(event) => {
        const point = pointOf(event, event.currentTarget);
        const found = point === null || !clickable ? null : boxAt(live, point);
        hover(found?.elementID ?? null);
      }}
      onPointerLeave={() => {
        hover(null);
      }}
      onPointerDownCapture={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        const point = pointOf(event, event.currentTarget);
        if (point === null) return;
        const found = boxAt(live, point);
        if (locked || !enabled) {
          record("pointer", {
            ...point,
            elementID: found?.elementID ?? null,
            outcome: !enabled ? "refused_disabled" : found === null ? "no_box" : "held",
          });
          onRefused();
          return;
        }
        const element = found === null ? undefined : byID.get(found.elementID);
        if (found === null || element === undefined) {
          record("pointer", { ...point, elementID: null, outcome: "no_box" });
          addRipple(point);
          if (onPoint !== undefined) setPressed(point);
          return;
        }
        if (element.kind !== "input") {
          addRipple(point);
          setPressed(point);
        }
        if (element.kind !== "input")
          onPress({
            elementID: found.elementID,
            box: found.box,
            clickT: eventSeconds(event.timeStamp),
          });
      }}
      onClick={(event) => {
        if (!enabled || event.target instanceof HTMLInputElement) return;
        const surface = event.currentTarget;
        const keyboard = event.detail === 0;
        const button =
          event.target instanceof Element ? event.target.closest("[data-element-id]") : null;
        const named = button instanceof HTMLElement ? button.dataset.elementId : undefined;
        const namedBox = live.find((found) => found.elementID === named);
        const point =
          keyboard && namedBox !== undefined
            ? {
                x: (namedBox.box.left + namedBox.box.right) / 2,
                y: (namedBox.box.top + namedBox.box.bottom) / 2,
              }
            : pointOf(event, surface);
        if (point === null) return;
        const found = boxAt(live, point);
        const element = found === null ? undefined : byID.get(found.elementID);
        if (found === null && onPoint !== undefined) {
          if (!locked) record("pointer", { ...point, elementID: null, outcome: "point" });
          onPoint(point.x, point.y);
          return;
        }
        if (found === null || element === undefined || element.kind === "input") return;
        if (!locked) record("pointer", { ...point, elementID: element.id, outcome: "accepted" });
        if (onPoint === undefined) onClick(element);
        else onPoint(point.x, point.y);
      }}
    >
      {locked && pressed !== null ? (
        <span
          className="press-mark"
          aria-hidden="true"
          style={{ left: `${pressed.x * 100}%`, top: `${pressed.y * 100}%` }}
        />
      ) : null}
      {ripples.map((ripple) => (
        <span
          key={ripple.id}
          className="ripple"
          style={{ left: `${ripple.x}%`, top: `${ripple.y}%` }}
          onAnimationEnd={() => {
            setRipples((current) => current.filter((item) => item.id !== ripple.id));
          }}
        />
      ))}
      {live.map((found) => {
        const element = byID.get(found.elementID);
        if (element === undefined) return null;
        const style = {
          left: `${found.box.left * 100}%`,
          top: `${found.box.top * 100}%`,
          width: `${(found.box.right - found.box.left) * 100}%`,
          height: `${(found.box.bottom - found.box.top) * 100}%`,
        };
        return (
          <div
            key={element.id}
            className={`hitbox hitbox-kind-${element.kind}`}
            style={style}
            data-element-id={element.id}
            data-label={element.label}
            data-hover={hovered === element.id}
          >
            {debug ? (
              <span className="hitbox-label">
                {element.label} {Math.round(found.presence * 100)}%
              </span>
            ) : null}
            {element.kind === "input" ? (
              <InputBox
                element={element}
                onType={(target, text) => {
                  if (locked) onRefused();
                  onType(target, text);
                }}
              />
            ) : (
              <button
                type="button"
                className="hitbox-button"
                aria-label={element.label}
                disabled={!enabled}
                tabIndex={clickable ? 0 : -1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
