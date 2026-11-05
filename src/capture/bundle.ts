import { getRunID, record, subscribe, type RunEvent } from "../run-log/index.ts";
import { get, keys, put, remove } from "../storage/index.ts";

const safeName = /^[A-Za-z0-9._/-]+$/;
let devChain: Promise<unknown> = Promise.resolve();
const appendCounts = new Map<string, number>();

const keepaliveLimit = 60_000;
const keptBundles = 10;

function devWrite(name: string, data: Blob | string, append: boolean): void {
  if (!import.meta.env.DEV) return;
  const query = new URLSearchParams({ runID: getRunID(), name, append: append ? "1" : "0" });
  if (!append && typeof data === "string" && data.length < keepaliveLimit) {
    void fetch(`/__dev/capture?${query.toString()}`, {
      method: "POST",
      body: data,
      keepalive: true,
    }).catch((error: unknown) => {
      record("capture_failed", { name, message: String(error) });
    });
    return;
  }
  devChain = devChain
    .then(() => fetch(`/__dev/capture?${query.toString()}`, { method: "POST", body: data }))
    .catch((error: unknown) => {
      record("capture_failed", { name, message: String(error) });
    });
}

/**
 * Saves one file of this session's bundle: in IndexedDB under the run id, and in dev also to
 * `.agent/sessions/<runID>/<name>`. Fire and forget, never on the click path's critical work. A
 * small text file is sent at once with keepalive, so it lands even while the tab closes.
 */
export function captureFile(name: string, data: Blob | string): void {
  if (!safeName.test(name) || name.includes("..")) {
    record("capture_failed", { name, message: "unsafe name" });
    return;
  }
  void put("captures", `${getRunID()}/${name}`, data);
  devWrite(name, data, false);
}

/** Appends a part to a file of the bundle, such as the recording, in order. */
export function appendFile(name: string, data: Blob): void {
  const count = appendCounts.get(name) ?? 0;
  appendCounts.set(name, count + 1);
  void put("captures", `${getRunID()}/${name}#${String(count).padStart(6, "0")}`, data);
  devWrite(name, data, true);
}

const runOf = (key: string) => key.slice(0, key.indexOf("/"));

async function pruneBundles(): Promise<void> {
  const all = await keys("captures");
  const newest = [...new Set(all.map(runOf))].sort().reverse().slice(0, keptBundles);
  const kept = new Set([getRunID(), ...newest]);
  const doomed = all.filter((key) => !kept.has(runOf(key)));
  if (doomed.length === 0) return;
  await remove("captures", doomed);
  record("bundles_pruned", { bundles: new Set(doomed.map(runOf)).size, files: doomed.length });
}

/**
 * Mirrors the run log into the bundle as it grows, in batches. Called once a session starts, it
 * first deletes every bundle in this browser but this run's and the newest ten, so recordings and
 * frames do not pile up in IndexedDB, and logs `bundles_pruned`.
 */
export function mirrorRunLog(): () => void {
  void pruneBundles();
  let written = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: readonly RunEvent[] = [];
  const flush = () => {
    timer = null;
    const batch = latest.slice(written);
    written = latest.length;
    if (batch.length === 0) return;
    const text = batch.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const count = appendCounts.get("run-log.jsonl") ?? 0;
    appendCounts.set("run-log.jsonl", count + 1);
    void put("captures", `${getRunID()}/run-log.jsonl#${String(count).padStart(6, "0")}`, text);
  };
  const unsubscribe = subscribe((events) => {
    latest = events;
    timer ??= setTimeout(flush, 2000);
  });
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    flush();
  };
}

/** The run ids that have a bundle in this browser, newest first. */
export async function listBundles(): Promise<string[]> {
  const all = await keys("captures");
  const ids = new Set(all.map(runOf));
  return [...ids].sort().reverse();
}

/** Every file of one bundle, with appended parts joined in order. */
export async function readBundle(runID: string): Promise<Map<string, Blob>> {
  const files = new Map<string, Blob[]>();
  for (const key of await keys("captures", `${runID}/`)) {
    const value = await get("captures", key);
    const part =
      value instanceof Blob ? value : typeof value === "string" ? new Blob([value]) : null;
    if (part === null) continue;
    const name = key.slice(runID.length + 1).replace(/#\d+$/, "");
    files.set(name, [...(files.get(name) ?? []), part]);
  }
  return new Map(
    [...files].map(([name, parts]) => [
      name,
      new Blob(parts, { type: name.endsWith(".webm") ? "video/webm" : "" }),
    ]),
  );
}
