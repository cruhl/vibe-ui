import { boxAt, type Point } from "../boxes/index.ts";
import { currentKeys, emptyKeys, getOpenAIAccess } from "../keys/index.ts";
import { captureFrame } from "../frame/index.ts";
import { currentRoute, routeURL, type Route } from "../route/index.ts";
import { flushNow, getEvents, getRunID, record, subscribe } from "../run-log/index.ts";
import { get } from "../storage/index.ts";
import { z } from "zod";
import { AgentReplay } from "./agent-replay.ts";
import { Fixture } from "./capture.ts";
import { realCallsInFlight, sleep, whileThinking } from "./clock.ts";
import type { ShimOptions } from "./fetch-shim.ts";
import { boxTarget, Human } from "./human.ts";
import prices from "./prices.json";
import { buildReport, Prices, summarizeReport } from "./report.ts";
import { parseEvalCase, type EvalCase, type ScriptStep } from "./case.ts";
import { evalStore } from "./store.ts";
import type { EvalTarget } from "./target.ts";
import { decide, type UserDecision } from "./user.ts";

const caseFiles = import.meta.glob<string>("./cases/*.md", {
  query: "?raw",
  import: "default",
});
const replayFiles = import.meta.glob<unknown>("./replays/*.json", { import: "default" });

/** How one eval run is wired, read from the page URL. */
export interface EvalOptions {
  caseName: string;
  omni: "mock" | "real";
  jev: "mock" | "real";
  agent: "real" | "replay";
  replay: string | null;
  user: "llm" | "scripted" | null;
  speed: number;
}

/** The eval wiring of a route, or null when it runs no eval. */
export function evalOptions(route: Route): EvalOptions | null {
  return route.eval === null ? null : { ...route.eval, omni: route.omni, jev: route.jev };
}

async function loadEvalCase(name: string): Promise<EvalCase> {
  const load = caseFiles[`./cases/${name}.md`];
  if (load === undefined)
    throw new Error(
      `no eval case ${name}; known: ${Object.keys(caseFiles)
        .map((path) => path.replace(/^.*\/|\.md$/g, ""))
        .join(", ")}`,
    );
  return parseEvalCase(name, await load());
}

async function loadReplay(name: string): Promise<AgentReplay> {
  const load = replayFiles[`./replays/${name}.json`];
  if (load === undefined) throw new Error(`no agent replay fixture ${name} in src/eval/replays`);
  return new AgentReplay(Fixture.parse(await load()));
}

interface VisibleBox {
  elementID: string;
  kind: string;
  label: string;
  box: { top: number; bottom: number; left: number; right: number };
  presence: number;
}

const labeled = (boxes: readonly VisibleBox[], label: string) =>
  boxes.find((box) => box.label.trim().toUpperCase() === label.trim().toUpperCase());

function visibleBoxes(app: EvalTarget): VisibleBox[] {
  const state = app.store.getState();
  const elements = new Map(state.view.elements.map((element) => [element.id, element]));
  return state.boxes.flatMap((found) => {
    const element = elements.get(found.elementID);
    if (element === undefined || found.presence < 0.5) return [];
    return [
      {
        elementID: found.elementID,
        kind: element.kind,
        label: element.label,
        box: found.box,
        presence: Math.round(found.presence * 100) / 100,
      },
    ];
  });
}

function scriptedDecision(step: ScriptStep, boxes: readonly VisibleBox[]): UserDecision | null {
  if (step.action === "wait") return null;
  if (step.action === "click-label") {
    const box = labeled(boxes, step.label);
    if (box === undefined) return null;
    return scriptedDecision(
      { action: "click", elementID: box.elementID, intent: step.intent ?? `click ${step.label}` },
      boxes,
    );
  }
  const wordsRead = boxes.reduce((total, box) => total + box.label.split(/\s+/).length, 0);
  const base = { thought: "scripted", wordsRead, goalProgress: null, waitSeconds: null };
  if (step.action === "click-point")
    return {
      ...base,
      intent: step.intent ?? `click at ${step.x}, ${step.y}`,
      action: "click",
      elementID: null,
      x: step.x,
      y: step.y,
      text: null,
      goalProgress: 0,
    };
  return {
    ...base,
    intent: step.intent ?? `${step.action} ${step.elementID}`,
    action: step.action,
    elementID: step.elementID,
    x: null,
    y: null,
    text: step.action === "type" ? step.text : null,
    goalProgress: 0,
  };
}

/** Prepares the agent replay before the session starts, when the run asks for one. */
export async function prepareReplay(options: EvalOptions, shim: ShimOptions): Promise<EvalCase> {
  const evalCase = await loadEvalCase(options.caseName);
  if (options.agent === "replay") {
    const name = options.replay ?? evalCase.replay;
    if (name === null) throw new Error(`eval case ${evalCase.name} names no agent replay fixture`);
    shim.replay = await loadReplay(name);
    record("agent_replay_loaded", { fixture: name });
  }
  return evalCase;
}

const QueuedClip = z.looseObject({
  kind: z.literal("clip_queued"),
  slot: z.number(),
  clipID: z.string(),
  promptFile: z.string(),
});

/**
 * Logs `eval_clip` with the prompt of every clip the controller queues, on any slot, read back from
 * the prompt file it captured into this session's bundle, so the judge can name what each clip was
 * asked to show.
 */
function recordClipPrompts(): void {
  let seen = 0;
  subscribe((events) => {
    const fresh = events.slice(seen);
    seen = events.length;
    for (const event of fresh) {
      const queued = QueuedClip.safeParse(event);
      if (!queued.success) continue;
      const { slot, clipID, promptFile } = queued.data;
      void get("captures", `${getRunID()}/${promptFile}`).then((prompt) => {
        record("eval_clip", { slot, clipID, prompt: typeof prompt === "string" ? prompt : null });
      });
    }
  });
}

/**
 * Runs one eval case in this page: starts the session, then a simulated user looks at the live
 * frame, decides (the scripted step or the model), waits its modeled human delays on the content
 * clock, moves the visible cursor, and acts through the controller's `input`, the overlay's own
 * entry point. Ends the session, then builds the report from this page's run log.
 */
export async function runEval(
  app: EvalTarget,
  options: EvalOptions,
  evalCase: EvalCase,
): Promise<void> {
  const mode = `omni ${options.omni}, jev ${options.jev}, agent ${options.agent}, user ${options.user ?? evalCase.user}, x${options.speed}`;
  evalStore.setState({ caseName: evalCase.name, mode, status: "running" });
  const userMode = options.user ?? evalCase.user;
  if (currentRoute().scenario !== evalCase.preset) {
    location.replace(routeURL({ preset: evalCase.preset }));
    return;
  }
  const keys = currentKeys() ?? emptyKeys();
  if (app.store.getState().phase === "keys") app.start(keys);
  recordClipPrompts();
  let lastView = app.store.getState().view;
  app.store.subscribe((next) => {
    if (next.view === lastView) return;
    lastView = next.view;
    record("eval_state", {
      scene: next.view.scene,
      elements: next.view.elements.map((element) => element.label),
    });
  });
  record("eval_start", { caseName: evalCase.name, options, userMode });

  const human = new Human(evalCase.human);
  const startedAt = performance.now();
  const limitMs = evalCase.limits.maxSeconds * 1000;
  const readyMs = evalCase.deadlines.readySeconds * 1000;
  let cursor: Point = { x: 0.5, y: 0.5 };
  const history: string[] = [];
  let inputsSent = 0;
  let scriptIndex = 0;
  let step = 0;
  let lastSignature = "";
  let lastLookAt = 0;
  let usableSince = performance.now();
  const seconds = () => Math.round((performance.now() - startedAt) / 100) / 10;

  for (;;) {
    const state = app.store.getState();
    if (state.phase === "ended") {
      record("eval_session_ended", { error: state.error });
      break;
    }
    if (performance.now() - startedAt >= limitMs) {
      record("eval_limit", { limit: "maxSeconds" });
      break;
    }
    if (inputsSent >= evalCase.limits.maxInputs) {
      record("eval_limit", { limit: "maxInputs" });
      break;
    }
    const video = app.video;
    const frame = video === null ? null : captureFrame(video);
    const boxes = visibleBoxes(app);
    const stalled = performance.now() - usableSince > readyMs;
    if (frame === null || boxes.length === 0) {
      if (stalled) {
        record("eval_stall", {
          waitedSeconds: evalCase.deadlines.readySeconds,
          frame: frame !== null,
        });
        break;
      }
      await sleep(human.glance());
      continue;
    }
    let decision: UserDecision | null;
    let usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    if (userMode === "scripted") {
      const scripted = evalCase.script[scriptIndex];
      if (scripted === undefined) {
        record("eval_script_done", { steps: scriptIndex });
        break;
      }
      if (scripted.action === "wait") {
        scriptIndex++;
        await sleep(scripted.seconds * 1000);
        continue;
      }
      const ready =
        !state.busy &&
        state.locked === null &&
        (scripted.action !== "click-label" || !scripted.settled || state.heldReady);
      const present =
        scripted.action === "click-point" ||
        (scripted.action === "click-label"
          ? labeled(boxes, scripted.label) !== undefined
          : boxes.some((box) => box.elementID === scripted.elementID));
      if (scripted.action === "click-label" && ready && !present && state.heldReady) {
        record("eval_step_skipped", { step: scripted, labels: boxes.map((box) => box.label) });
        scriptIndex++;
        continue;
      }
      if (!ready || !present) {
        if (stalled) {
          record("eval_stall", { waitedSeconds: evalCase.deadlines.readySeconds, step: scripted });
          break;
        }
        await sleep(human.glance());
        continue;
      }
      scriptIndex++;
      decision = scriptedDecision(scripted, boxes);
    } else {
      const signature = [
        state.playingClipID,
        state.busy,
        state.boxesSource,
        boxes.map((box) => box.elementID).join(","),
      ].join("|");
      if (signature === lastSignature && performance.now() - lastLookAt < readyMs / 2) {
        await sleep(human.glance());
        continue;
      }
      lastSignature = signature;
      lastLookAt = performance.now();
      try {
        const answer = await whileThinking(() =>
          decide(getOpenAIAccess(keys), {
            persona: evalCase.persona,
            frameBase64: frame.base64,
            boxes,
            history: history.slice(-12),
            inputsLeft: evalCase.limits.maxInputs - inputsSent,
            secondsLeft: (limitMs - (performance.now() - startedAt)) / 1000,
            playing: state.playingClipID !== null,
          }),
        );
        decision = answer.decision;
        usage = answer;
      } catch (error: unknown) {
        record("eval_user_failed", { message: String(error) });
        break;
      }
    }
    if (decision === null) continue;
    usableSince = performance.now();
    step++;
    record("eval_look", {
      step,
      ...usage,
      action: decision.action,
      intent: decision.intent,
      thought: decision.thought,
      goalProgress: userMode === "llm" ? decision.goalProgress : null,
      playingClipID: state.playingClipID,
      busy: state.busy,
    });
    evalStore.setState({ caption: decision.intent });
    if (decision.action === "wait") {
      const waitMs = Math.min(10, Math.max(0.5, decision.waitSeconds ?? 1)) * 1000;
      history.push(`${seconds()}s waited ${waitMs / 1000}s: ${decision.thought}`);
      await sleep(waitMs);
      continue;
    }
    if (decision.action === "done") {
      record("eval_user_done", { thought: decision.thought, goalProgress: decision.goalProgress });
      break;
    }
    const intended = boxes.find((box) => box.elementID === decision.elementID) ?? null;
    const aim =
      intended !== null
        ? boxTarget(intended.box)
        : decision.x !== null && decision.y !== null
          ? { center: { x: decision.x, y: decision.y }, size: { width: 0.05, height: 0.05 } }
          : null;
    if (aim === null) {
      history.push(
        `${seconds()}s tried ${decision.elementID ?? "nothing"}, which is not on screen`,
      );
      continue;
    }
    const lookT = performance.now();
    const plan = human.plan(cursor, aim.center, aim.size, decision.wordsRead, decision.text ?? "");
    await sleep(plan.reactionMs + plan.readingMs + plan.idleMs);
    evalStore.setState({ cursor: plan.point, travelMs: plan.travelMs, pressed: false });
    await sleep(plan.travelMs + plan.hesitationMs);
    if (decision.action === "type") await sleep(plan.typingMs);
    let point = plan.point;
    let correctionMs = 0;
    const moved = visibleBoxes(app).find((box) => box.elementID === intended?.elementID);
    if (!plan.misclicked && moved !== undefined && boxAt([moved], point) === null) {
      const target = boxTarget(moved.box);
      correctionMs = human.travel(point, target.center, target.size);
      point = target.center;
      evalStore.setState({ cursor: point, travelMs: correctionMs });
      await sleep(correctionMs);
    }
    evalStore.setState({ pressed: true });
    const landed = boxAt(visibleBoxes(app), point);
    const midClip = app.store.getState().playingClipID !== null;
    const before = getEvents().length;
    if (decision.action === "type" && landed !== null)
      app.input({ kind: "type", elementID: landed.elementID, text: decision.text ?? "" });
    else if (decision.action === "click") app.input({ kind: "click", x: point.x, y: point.y });
    const outcome =
      getEvents()
        .slice(before)
        .find((event) => ["input", "input_buffered", "input_ignored"].includes(event.kind))?.kind ??
      "none";
    const accepted = outcome === "input" || outcome === "input_buffered";
    if (accepted) inputsSent++;
    const intendedElementID = intended?.elementID ?? null;
    record("eval_action", {
      step,
      action: decision.action,
      intent: decision.intent,
      thought: decision.thought,
      intendedElementID,
      point,
      landedElementID: landed?.elementID ?? null,
      intentHit: intendedElementID !== null && landed?.elementID === intendedElementID,
      misclicked: plan.misclicked,
      accepted,
      outcome,
      midClip,
      lookT: Math.round(lookT) / 1000,
      delaysMs: {
        reaction: Math.round(plan.reactionMs),
        reading: Math.round(plan.readingMs),
        idle: Math.round(plan.idleMs),
        travel: Math.round(plan.travelMs),
        hesitation: Math.round(plan.hesitationMs),
        typing: decision.action === "type" ? Math.round(plan.typingMs) : 0,
        correction: Math.round(correctionMs),
      },
    });
    evalStore.setState({
      actions: [
        ...evalStore.getState().actions,
        {
          step,
          t: seconds(),
          action: decision.action,
          intent: decision.intent,
          intendedElementID,
          landedElementID: landed?.elementID ?? null,
          accepted,
        },
      ],
    });
    history.push(
      `${seconds()}s ${decision.action} aimed at ${intendedElementID ?? "a point"}, landed on ${landed?.label ?? "nothing"}: ${accepted ? "the app took it" : "nothing happened"}`,
    );
    cursor = point;
    await sleep(120);
    evalStore.setState({ pressed: false });
  }

  const answerMs = evalCase.deadlines.clickToFirstFrameSeconds * 1000;
  const lastInput = getEvents().findLast((event) => event.kind === "input");
  const settleUntil = performance.now() + answerMs;
  while (
    performance.now() < settleUntil &&
    app.store.getState().phase === "running" &&
    lastInput !== undefined &&
    !getEvents().some((event) => event.kind === "first_frame" && event.t >= lastInput.t)
  )
    await sleep(100);
  const drainUntil = performance.now() + evalCase.deadlines.readySeconds * 1000;
  while (performance.now() < drainUntil && realCallsInFlight() > 0) await sleep(100);
  await sleep(500);
  await app.end("eval_done");
  await sleep(300);
  const report = buildReport(getEvents(), evalCase.deadlines, Prices.parse(prices));
  const summary = summarizeReport(evalCase.name, mode, report);
  record("eval_done", { ok: report.ok, summary });
  flushNow();
  evalStore.setState({ status: "done", report, summary, caption: null });
}
