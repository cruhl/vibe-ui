import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { clockRate } from "./clock.ts";
import { evalStore } from "./store.ts";
import type { EvalTarget } from "./target.ts";

function useVideoRect(target: EvalTarget): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      const video = target.video;
      const next = video?.getBoundingClientRect() ?? null;
      setRect((current) =>
        next === null ||
        (current !== null &&
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width)
          ? current
          : next,
      );
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target]);
  return rect;
}

/**
 * The simulated user made visible: a cursor that travels to each target over its modeled travel
 * time, a caption with what it is trying to do, and a status line with the run's result.
 */
export function EvalPanel({ target }: { target: EvalTarget }) {
  const state = useStore(evalStore);
  const rect = useVideoRect(target);
  const rate = clockRate();
  const wallMs = rate === 0 ? 0 : state.travelMs / rate;
  const left = rect === null ? 0 : rect.left + state.cursor.x * rect.width;
  const top = rect === null ? 0 : rect.top + state.cursor.y * rect.height;
  const last = state.actions.at(-1);
  return (
    <>
      {rect === null ? null : (
        <div
          style={{
            position: "fixed",
            left,
            top,
            zIndex: 1000,
            pointerEvents: "none",
            transition: `left ${wallMs}ms ease-in-out, top ${wallMs}ms ease-in-out`,
          }}
        >
          <svg width="28" height="28" viewBox="0 0 28 28" style={{ display: "block" }}>
            <path
              d="M2 2 L2 22 L8 16 L12 26 L16 24 L12 14 L20 14 Z"
              fill={state.pressed ? "#ffd400" : "#ffffff"}
              stroke="#000000"
              strokeWidth="1.5"
            />
          </svg>
          {state.caption === null ? null : (
            <div
              style={{
                marginTop: 4,
                marginLeft: 18,
                padding: "3px 8px",
                maxWidth: 320,
                background: "rgba(0, 0, 0, 0.82)",
                color: "#ffd400",
                font: "600 14px/1.3 system-ui, sans-serif",
                borderRadius: 4,
                whiteSpace: "normal",
              }}
            >
              {state.caption}
            </div>
          )}
        </div>
      )}
      <div
        data-testid="eval-panel"
        style={{
          position: "fixed",
          right: 8,
          top: 8,
          zIndex: 1001,
          maxWidth: 420,
          padding: "6px 10px",
          background: "rgba(0, 0, 0, 0.78)",
          color: "#ffffff",
          font: "12px/1.4 ui-monospace, monospace",
          borderRadius: 4,
          pointerEvents: "none",
        }}
      >
        <div>
          eval {state.caseName} ({state.mode}): {state.status}
        </div>
        {last === undefined ? null : (
          <div>
            #{last.step} {last.action} {last.intendedElementID ?? "point"} landed{" "}
            {last.landedElementID ?? "nothing"} {last.accepted ? "accepted" : "not accepted"}
          </div>
        )}
        {state.summary === null ? null : (
          <div>{state.summary.split(" | ").slice(0, 3).join(" | ")}</div>
        )}
        {state.error === null ? null : <div style={{ color: "#ff8080" }}>{state.error}</div>}
      </div>
    </>
  );
}
