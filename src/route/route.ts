/**
 * Mechanics that the eval climbs, each from its own URL parameter: `guesses` written per moment,
 * `depth` steps below the moment on stage that are filmed ahead, `write` steps below it whose guesses are
 * already written (each with its answer), `budget` builds a session may hold at once (the running
 * one and those waiting), and `warmPause` seconds a paused pool stays connected before it is
 * ended.
 */
export interface Knobs {
  guesses: number;
  /**
   * The moment on stage gets a written answer for every thing on it that takes a click (`wide`,
   * on by default; `wide=0` keeps `guesses` everywhere); moments one step ahead get `guesses`,
   * and deeper ones one fewer.
   */
  wide: boolean;
  /**
   * Ask the agent again only when its change is unusable, dropping rejected lines (`unusable`, the
   * default), or on any rejected line (`errors`).
   */
  reask: "errors" | "unusable";
  /** The agent model for line turns, or null for the default, and its reasoning effort. */
  model: string | null;
  effort: "none" | "minimal" | "low" | "omit";
  depth: number;
  write: number;
  budget: number;
  warmPauseSeconds: number;
}

/**
 * The `bake` parameters: keep every moment the run films in the scenario's folder, up to a size
 * cap (`bakeCap`, megabytes), or only check the saved tree. How deep the run films and writes are
 * the same `depth` and `write` knobs a live run reads.
 */
export interface BakeMode {
  mode: "bake" | "check";
  capBytes: number;
}

/** An eval run's wiring: `eval=<case>` with its user, agent and speed. */
export interface EvalRoute {
  caseName: string;
  agent: "real" | "replay";
  replay: string | null;
  user: "llm" | "scripted" | null;
  speed: number;
}

/** Everything the page URL says, parsed once by the one reader of the URL contract. */
export interface Route {
  /** The scenario to run, a preset folder or a written one (`preset`), or null for the picker. */
  scenario: string | null;
  /** Whether the page opens on the picker: no scenario, no driver asking to start, no eval. */
  home: boolean;
  /** Open the keys screen even when keys are saved (`keys`). */
  keys: boolean;
  /** Connect on load with saved keys (`autostart`). */
  autostart: boolean;
  /** Debug mode at load (`debug=1`): boxes, labels and the debug panel. */
  debug: boolean;
  /** An idea to write into a scenario the moment the picker opens (`idea`). */
  idea: string | null;
  /** The scenario a session just ended in, which the picker names (`ended`). */
  ended: string | null;
  knobs: Knobs;
  bake: BakeMode | null;
  /** Sessions in the pool (`pool`), 1 to 8. */
  pool: number;
  /**
   * The stand-in Omni (`omni=mock`, or any replay kit) with its injected faults (`mockFault`) and
   * how much every mocked wait is stretched (`delays`: 1 as measured, 0.1 ten times faster, 0 at
   * once).
   */
  omni: "mock" | "real";
  mockFaults: string | null;
  delays: number;
  /** A replay kit to play a captured session through every mock seam (`kit=<runID>`). */
  kit: string | null;
  /** The stand-in Jev (`jev=mock`). */
  jev: "mock" | "real";
  eval: EvalRoute | null;
}

const defaultPool = 5;
const maxPool = 8;
const defaultCapMegabytes = 16;

/** Reads the whole URL contract from a query string. */
export function readRoute(search: string): Route {
  const parameters = new URLSearchParams(search);
  const integer = (name: string, fallback: number, low: number, high: number) => {
    const value = Number(parameters.get(name) ?? fallback);
    return Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback;
  };
  const baking = parameters.has("bake");
  const cap = Number(parameters.get("bakeCap") ?? defaultCapMegabytes);
  const pool = Number(parameters.get("pool") ?? defaultPool);
  const evalCase = parameters.get("eval");
  const user = parameters.get("user");
  const kit = parameters.get("kit");
  const delays = Number(parameters.get("delays") ?? "1");
  const scenario = parameters.get("preset");
  return {
    scenario,
    home:
      scenario === null && !parameters.has("autostart") && (evalCase === null || evalCase === ""),
    keys: parameters.has("keys"),
    autostart: parameters.has("autostart"),
    debug: parameters.get("debug") === "1",
    idea: parameters.get("idea"),
    ended: parameters.get("ended"),
    knobs: {
      guesses: integer("guesses", 3, 0, 5),
      wide: parameters.get("wide") !== "0",
      reask: parameters.get("reask") === "errors" ? "errors" : "unusable",
      model: parameters.get("model"),
      effort:
        (["minimal", "low", "omit"] as const).find((value) => value === parameters.get("effort")) ??
        "none",
      depth: integer("depth", 2, 0, 3),
      write: integer("write", 3, 0, 4),
      budget: integer("budget", 2, 1, 4),
      warmPauseSeconds: integer("warmPause", 120, 1, 3600),
    },
    bake: baking
      ? {
          mode: parameters.get("bake") === "check" ? "check" : "bake",
          capBytes: (Number.isFinite(cap) && cap > 0 ? cap : defaultCapMegabytes) * 1_000_000,
        }
      : null,
    pool: Number.isInteger(pool) ? Math.min(maxPool, Math.max(1, pool)) : defaultPool,
    omni: parameters.get("omni") === "mock" || (kit !== null && kit !== "") ? "mock" : "real",
    mockFaults: parameters.get("mockFault"),
    delays: Number.isFinite(delays) && delays >= 0 ? delays : 1,
    kit: kit === null || kit === "" ? null : kit,
    jev: parameters.get("jev") === "mock" ? "mock" : "real",
    eval:
      evalCase === null || evalCase === ""
        ? null
        : {
            caseName: evalCase,
            agent: parameters.get("agent") === "replay" ? "replay" : "real",
            replay: parameters.get("replay"),
            user: user === "llm" || user === "scripted" ? user : null,
            speed: Math.max(0.1, Number(parameters.get("speed") ?? "1") || 1),
          },
  };
}

/** The route of this page as it is now. */
export const currentRoute = () => readRoute(location.search);

/** A URL parameter the app writes; every other parameter is only ever read. */
type Written = "preset" | "keys" | "autostart" | "idea" | "ended";

/**
 * This page's path and query with some parameters changed: a string sets one, null removes it,
 * and every other parameter is kept.
 */
export function routeURL(changes: Partial<Record<Written, string | null>> = {}): string {
  const parameters = new URLSearchParams(location.search);
  for (const [name, value] of Object.entries(changes))
    if (value === null) parameters.delete(name);
    else parameters.set(name, value);
  const query = parameters.toString();
  return `${location.pathname}${query === "" ? "" : `?${query}`}`;
}

/** Puts `routeURL(changes)` in the address bar in place, with no load. */
export function replaceRoute(changes: Partial<Record<Written, string | null>>): void {
  history.replaceState(null, "", routeURL(changes));
}

/** The URL that opens a scenario, or the picker for null, with every one-shot parameter dropped. */
export function scenarioURL(scenarioID: string | null): string {
  return routeURL({ preset: scenarioID, autostart: null, idea: null, ended: null });
}

/** The full link that opens a scenario anywhere: this page with only `preset` in its query. */
export function sharedScenarioURL(scenarioID: string): string {
  return `${location.origin}${location.pathname}?${new URLSearchParams({ preset: scenarioID }).toString()}`;
}

/** The picker's URL carrying an idea to write the moment it opens. */
export function ideaURL(idea: string): string {
  return routeURL({ preset: null, autostart: null, ended: null, idea });
}

/** The picker's URL after a session ends, naming the scenario it ended in. */
export function endedURL(scenarioID: string): string {
  return routeURL({ preset: null, autostart: null, idea: null, ended: scenarioID });
}

/** This page's URL with the keys screen asked for. */
export function keysURL(): string {
  return routeURL({ keys: "1" });
}

/** Takes a one-shot parameter out of the address bar, so a reload never acts on it twice. */
export function takeFromRoute(name: "idea" | "ended"): string | null {
  const value = new URLSearchParams(location.search).get(name);
  if (value !== null) replaceRoute({ [name]: null });
  return value;
}
