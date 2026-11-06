import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { z } from "zod";
import type { OpenAIAccess } from "../agent/index.ts";
import type { FalAccess } from "../assets/index.ts";
import { jevModel, type JevConnection } from "../jev/index.ts";
import type { ReactorAccess } from "../omni/index.ts";
import { getRunID, record, rememberSecret } from "../run-log/index.ts";
import { decodeLinkedKeys, linkParameter } from "./link.ts";
import { ensurePass, hostedFetch, setPassKey } from "./pass.ts";

/** A visitor's own keys, as this browser saves them. */
export const OwnKeys = z.object({
  reactor: z.string(),
  openAI: z.string(),
  typesafe: z.string(),
  fal: z.string().default(""),
});
export type OwnKeys = z.infer<typeof OwnKeys>;

/**
 * What a page runs on: the visitor's own keys (`hosted` false), or hosted play (`hosted` true),
 * where this site's Worker holds the keys and every key field here is empty.
 */
export interface Keys extends OwnKeys {
  hosted: boolean;
}

/** What this deployment's Worker says before the page starts (`/api/config`). */
export const HostedPlay = z.object({
  hosted: z.boolean(),
  sessions: z.number(),
  fal: z.boolean(),
  turnstile: z.string().nullable(),
});
export type HostedPlay = z.infer<typeof HostedPlay>;

const storageKey = "vibe-ui.keys";
const configDeadlineMs = 1500;

/** Keys with every field empty, on the visitor's own keys. */
export function emptyKeys(): Keys {
  return { reactor: "", openAI: "", typesafe: "", fal: "", hosted: false };
}

const hostedKeys: Keys = { reactor: "", openAI: "", typesafe: "", fal: "", hosted: true };

/** Whether a set of keys can run a world: hosted play, or every required own key present. */
export function isComplete(keys: Keys): boolean {
  return keys.hosted || (keys.reactor !== "" && keys.openAI !== "" && keys.typesafe !== "");
}

const origin = () => location.origin;

const ownFetch: typeof fetch = (input, init) => window.fetch(input, init);

const ownJevFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
  headers.set("X-Vibe-Session", getRunID());
  return window.fetch(input, { ...init, headers });
};

/** The Jev endpoint, key and model id: the Worker's hosted route, or `/jev` with the own key. */
export function getJevConnection(keys: Keys): JevConnection {
  return keys.hosted
    ? { baseURL: "/api/jev", key: "hosted", model: jevModel, fetch: hostedFetch }
    : { baseURL: "/jev", key: keys.typesafe, model: jevModel, fetch: ownJevFetch };
}

/** Where the agent's calls go: the Worker's hosted route, or OpenAI with the own key. */
export function getOpenAIAccess(keys: Keys): OpenAIAccess {
  return keys.hosted
    ? { apiKey: "hosted", baseURL: `${origin()}/api/openai/v1`, fetch: hostedFetch }
    : { apiKey: keys.openAI, baseURL: null, fetch: ownFetch };
}

/** How sessions reach Reactor: leases from the Worker, or tokens minted with the own key. */
export function getReactorAccess(keys: Keys | null): ReactorAccess {
  return keys?.hosted === true
    ? { kind: "hosted", baseURL: origin(), fetch: hostedFetch, ready: ensurePass }
    : { kind: "key", key: keys?.reactor ?? "" };
}

/** Where fal calls go, or null when there is no fal: hosted when the Worker has it, or the own key. */
export function getFalAccess(keys: Keys | null): FalAccess | null {
  if (keys === null) return null;
  if (keys.hosted)
    return store.getState().hosted?.fal === true
      ? { baseURL: "/api/fal", key: null, fetch: hostedFetch }
      : null;
  return keys.fal === "" ? null : { baseURL: "https://fal.run", key: keys.fal, fetch: ownFetch };
}

const SavedKeys = z
  .string()
  .transform((raw, context): unknown => {
    try {
      const value: unknown = JSON.parse(raw);
      return value;
    } catch {
      context.addIssue({ code: "custom", message: "saved keys are not JSON" });
      return z.NEVER;
    }
  })
  .pipe(OwnKeys);

function readSaved(): Keys | null {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return null;
  const parsed = SavedKeys.safeParse(raw);
  if (parsed.success) return { ...parsed.data, hosted: false };
  record("keys_invalid", { message: parsed.error.message });
  return null;
}

const LinkedKeys = OwnKeys.partial();

/** Saves keys a link carried in the URL fragment over the saved ones, and strips the fragment. */
function importLinkedKeys(): void {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const encoded = fragment.get(linkParameter);
  if (encoded === null) return;
  fragment.delete(linkParameter);
  const rest = fragment.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${rest === "" ? "" : `#${rest}`}`,
  );
  try {
    const linked = LinkedKeys.parse(JSON.parse(decodeLinkedKeys(encoded)));
    const { hosted: _hosted, ...saved } = readSaved() ?? emptyKeys();
    localStorage.setItem(storageKey, JSON.stringify({ ...saved, ...linked }));
    record("keys_linked", { fields: Object.keys(linked) });
  } catch {
    record("keys_link_invalid", {});
  }
}

const DevEnvironment = z.record(z.string(), z.string());

async function fillFromDev(keys: Keys): Promise<Keys> {
  if (!import.meta.env.DEV) return keys;
  const response = await fetch("/__dev/keys").catch(() => null);
  if (response?.ok !== true) return keys;
  const environment = DevEnvironment.parse(await response.json());
  const pick = (current: string, name: string) =>
    current !== "" ? current : (environment[name] ?? "");
  return {
    reactor: pick(keys.reactor, "REACTOR_API_KEY"),
    openAI: pick(keys.openAI, "OPENAI_API_KEY"),
    typesafe: pick(keys.typesafe, "TYPESAFE_API_KEY"),
    fal: pick(keys.fal, "FAL_KEY"),
    hosted: false,
  };
}

async function readHostedPlay(): Promise<HostedPlay | null> {
  try {
    const response = await fetch("/api/config", { signal: AbortSignal.timeout(configDeadlineMs) });
    if (!response.ok) return null;
    const parsed = HostedPlay.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface KeysState {
  /** The own keys: the saved set, in dev with empty fields filled from `.env.local`. */
  own: Keys | null;
  /** What the Worker said, or null with no Worker (dev) or no answer in time. */
  hosted: HostedPlay | null;
}

const store = createStore<KeysState>(() => ({ own: null, hosted: null }));

store.subscribe(({ own }) => {
  if (own === null) return;
  for (const key of [own.reactor, own.openAI, own.typesafe, own.fal]) rememberSecret(key);
});

/**
 * Reads everything the page runs on, once, before anything asks: keys a link carried, the saved
 * keys (filled from `.env.local` in dev), and this deployment's hosted play, whose answer is
 * waited for at most 1.5 s. When the page runs on hosted play it starts earning its pass at once.
 */
export async function loadKeys(): Promise<void> {
  importLinkedKeys();
  const saved = readSaved();
  const [own, hosted] = await Promise.all([
    import.meta.env.DEV ? fillFromDev(saved ?? emptyKeys()) : Promise.resolve(saved),
    readHostedPlay(),
  ]);
  record("keys_loaded", {
    own: own !== null && isComplete(own),
    hosted: hosted?.hosted ?? null,
  });
  store.setState({ own, hosted });
  setPassKey(hosted?.turnstile ?? null);
  if (currentKeys()?.hosted === true) void ensurePass();
}

function current(state: KeysState): Keys | null {
  if (state.own !== null && isComplete(state.own)) return state.own;
  return state.hosted?.hosted === true ? hostedKeys : null;
}

/** The keys the page runs on: complete own keys first, else hosted play, else null. */
export function currentKeys(): Keys | null {
  return current(store.getState());
}

/** The keys the page runs on, re-rendering when they change. */
export function useCurrentKeys(): Keys | null {
  return useStore(store, current);
}

/** The own keys saved in this browser (filled in dev), for the keys screen. */
export function savedKeys(): Keys | null {
  return store.getState().own;
}

/** What this deployment's Worker said about hosted play, or null. */
export function hostedPlay(): HostedPlay | null {
  return store.getState().hosted;
}

/** What the Worker said about hosted play, re-rendering when it changes. */
export function useHostedPlay(): HostedPlay | null {
  return useStore(store, (state) => state.hosted);
}

/** Saves own keys in this browser only, for every reader. */
export function saveKeys(keys: Keys): void {
  const { hosted: _hosted, ...own } = keys;
  localStorage.setItem(storageKey, JSON.stringify(own));
  store.setState({ own: { ...own, hosted: false } });
}

/** Forgets the own keys saved in this browser, so the page runs on hosted play again. */
export function forgetKeys(): void {
  localStorage.removeItem(storageKey);
  store.setState({ own: null });
}
