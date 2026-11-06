import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { z } from "zod";
import { readLocalEnvironment } from "../dev/environment.ts";

/** The repository root every script resolves its paths from. */
export const root = join(import.meta.dirname, "..");

/** Resolves after a number of milliseconds. */
export const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Whether something listens on a local port. */
export const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
  });

/** The repository's `.env.local` as a key/value record, empty when the file is absent. */
export function readEnvironment(): Record<string, string> {
  return readLocalEnvironment(join(root, ".env.local"));
}

/** The Cloudflare account a script deploys to or reads from, and the API token it acts with. */
export interface CloudflareCredentials {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

/**
 * `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from a dotenv file, and nothing else in it;
 * from the process environment when no file is given. Throws when the file is missing.
 */
export function cloudflareCredentials(environmentFile: string | null): CloudflareCredentials {
  const source =
    environmentFile === null
      ? process.env
      : existsSync(environmentFile)
        ? parseEnv(readFileSync(environmentFile, "utf8"))
        : null;
  if (source === null) throw new Error(`no env file at ${environmentFile ?? ""}`);
  const pick = (name: keyof CloudflareCredentials) => {
    const value = source[name];
    return value === undefined || value === "" ? {} : { [name]: value };
  };
  return { ...pick("CLOUDFLARE_API_TOKEN"), ...pick("CLOUDFLARE_ACCOUNT_ID") };
}

/** A logger that stamps each line with the wall-clock time and writes it to stdout and `file`. */
export function createLog(file?: string): (line: string) => void {
  return (line) => {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}\n`;
    process.stdout.write(stamped);
    if (file !== undefined) appendFileSync(file, stamped);
  };
}

const servers = new Set<DevServer>();
const browsers = new Set<Browser>();
const serverStartMs = 30_000;
const serverStopMs = 3_000;

/** A dev server a script started, at `url`. */
export interface DevServer {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/** How to start the dev server. */
export interface DevServerOptions {
  port: number;
  /** More `vite` arguments, such as `--force`. */
  extraArguments?: readonly string[];
  /** Runs the server in its own process group, which `stop` signals as a whole. */
  detached?: boolean;
  /** Appends the server's output to this file; without it stdout is dropped and stderr shown. */
  logFile?: string;
}

function signal(child: ChildProcess, detached: boolean, name: NodeJS.Signals): void {
  try {
    if (detached && child.pid !== undefined) process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    child.kill(name);
  }
}

async function stopProcess(child: ChildProcess, detached: boolean): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  signal(child, detached, "SIGTERM");
  const deadline = Date.now() + serverStopMs;
  while (!exited() && Date.now() < deadline) await sleep(100);
  if (!exited()) signal(child, detached, "SIGKILL");
}

/**
 * Starts the app's Vite dev server on `127.0.0.1:<port>` with hot reload and file watching off
 * (`VIBE_UI_NO_RELOAD=1`), refusing a port already in use, and resolves once the port answers.
 * Throws, with the server stopped, when it does not answer within 30 seconds.
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const { port, extraArguments = [], detached = false, logFile } = options;
  if (await portOpen(port))
    throw new Error(`port ${port} is already in use; choose another with --port`);
  const output = logFile === undefined ? "ignore" : openSync(logFile, "a");
  const child = spawn(
    join(root, "node_modules", ".bin", "vite"),
    ["--host", "127.0.0.1", "--port", String(port), "--strictPort", ...extraArguments],
    {
      cwd: root,
      detached,
      env: { ...process.env, VIBE_UI_NO_RELOAD: "1" },
      stdio: ["ignore", output, logFile === undefined ? "inherit" : output],
    },
  );
  if (typeof output === "number") closeSync(output);
  const spawnErrors: Error[] = [];
  child.on("error", (error) => spawnErrors.push(error));
  const server: DevServer = {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      servers.delete(server);
      await stopProcess(child, detached);
    },
  };
  servers.add(server);
  const deadline = Date.now() + serverStartMs;
  while (!(await portOpen(port))) {
    if (spawnErrors.length > 0 || child.exitCode !== null || Date.now() > deadline) {
      await server.stop();
      throw new Error(
        `the dev server did not start on port ${port}${spawnErrors.map((error) => `: ${error.message}`).join("")}`,
      );
    }
    await sleep(250);
  }
  return server;
}

/**
 * Launches Playwright's bundled full Chromium (`playwright install chromium`), headless unless
 * `headed`, with autoplay allowed and signals left to the script's cleanup. Never the headless
 * shell: its software compositor stops painting a video on stage while another video element
 * loads, so stills and recordings show the stage empty for a fraction of a second after a click.
 */
export async function launchBrowser(options: { headed?: boolean } = {}): Promise<Browser> {
  if (!existsSync(chromium.executablePath()))
    throw new Error(
      "Playwright's Chromium is not installed: run pnpm exec playwright install chromium --no-shell",
    );
  const browser = await chromium.launch({
    channel: "chromium",
    headless: options.headed !== true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  browsers.add(browser);
  browser.on("disconnected", () => browsers.delete(browser));
  return browser;
}

/** The keys the app saves in a browser under `vibe-ui.keys`. */
export type SavedKeys = { reactor: string; openAI: string; typesafe: string; fal: string };

/** The saved keys filled from `.env.local`, empty where a key is absent. */
export function keysFromEnvironment(): SavedKeys {
  const environment = readEnvironment();
  return {
    reactor: environment.REACTOR_API_KEY ?? "",
    openAI: environment.OPENAI_API_KEY ?? "",
    typesafe: environment.TYPESAFE_API_KEY ?? "",
    fal: environment.FAL_KEY ?? "",
  };
}

/** Saves keys in every page the context opens, before the app reads them. */
export async function seedKeys(context: BrowserContext, keys: SavedKeys): Promise<void> {
  await context.addInitScript((saved) => {
    localStorage.setItem("vibe-ui.keys", saved);
  }, JSON.stringify(keys));
}

const SessionState = z.looseObject({ state: z.string() });
const reactorTimeoutMs = 5000;

/**
 * The backstop every script runs after it ends its sessions in the page: reads one Reactor
 * session's state through the API, deletes it when it is not closed yet, and reads it again.
 * A state that cannot be read is `unknown`.
 */
export async function closeReactorSession(
  sessionID: string,
  key: string,
): Promise<{ before: string; after: string }> {
  const url = `https://api.reactor.inc/sessions/${sessionID}`;
  const headers = { "Reactor-API-Key": key };
  const read = () =>
    fetch(url, { headers, signal: AbortSignal.timeout(reactorTimeoutMs) })
      .then(async (response) => SessionState.parse(await response.json()).state)
      .catch(() => "unknown");
  const before = await read();
  if (before === "CLOSED") return { before, after: before };
  await fetch(url, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(reactorTimeoutMs),
  }).catch(() => undefined);
  return { before, after: await read() };
}

/**
 * Runs the backstop on each real Reactor session (ids starting with `mock-` are skipped) with the
 * `.env.local` key, and returns one line per session to log.
 */
export async function closeSessions(sessionIDs: Iterable<string>): Promise<string[]> {
  const real = [...new Set(sessionIDs)].filter((sessionID) => !sessionID.startsWith("mock-"));
  if (real.length === 0) return [];
  const key = readEnvironment().REACTOR_API_KEY;
  if (key === undefined || key === "")
    return [`no REACTOR_API_KEY in .env.local to close ${real.join(", ")}`];
  return Promise.all(
    real.map(async (sessionID) => {
      const { before, after } = await closeReactorSession(sessionID, key);
      return `session ${sessionID} was ${before}${before === "CLOSED" ? "" : `, closed through the API, now ${after}`}`;
    }),
  );
}

const RunEvent = z.looseObject({ kind: z.string(), sessionID: z.string().nullable().optional() });

/**
 * Runs the backstop on every Omni session a run's log (`.agent/runs/<runID>.jsonl`) names, and
 * returns one line per session to log.
 */
export async function closeRunSessions(runID: string | null): Promise<string[]> {
  if (runID === null) return [];
  const path = join(root, ".agent", "runs", `${runID}.jsonl`);
  if (!existsSync(path)) return [];
  return closeSessions(readFileSync(path, "utf8").split("\n").flatMap(sessionIDOf));
}

function sessionIDOf(line: string): string[] {
  try {
    const event = RunEvent.parse(JSON.parse(line));
    return event.kind === "omni_session_id" && typeof event.sessionID === "string"
      ? [event.sessionID]
      : [];
  } catch {
    return [];
  }
}

async function stopStarted(): Promise<void> {
  await Promise.all(
    [...browsers].map((browser) =>
      Promise.race([browser.close().catch(() => undefined), sleep(5000)]),
    ),
  );
  await Promise.all([...servers].map((server) => server.stop()));
}

/** The shared cleanup: the script's own steps, when it fires on its own, and where it logs. */
export interface CleanupOptions {
  /** The script's own steps, such as ending sessions in the page and the API backstop. */
  end?: (reason: string) => Promise<void>;
  /** Ends the run with exit code 2 after this long; null for no hard timeout. */
  timeoutMs: number | null;
  log?: (line: string) => void;
}

/**
 * Wires one cleanup to SIGINT (exit 130), SIGTERM (exit 143) and the hard timeout (exit 2). It
 * runs at most once: the script's `end`, then it stops every browser and dev server this harness
 * started. Returns that same path for the script's normal and error exits.
 */
export function registerCleanup(options: CleanupOptions): (reason: string) => Promise<void> {
  const { end, timeoutMs } = options;
  const log = options.log ?? createLog();
  let running: Promise<void> | null = null;
  const finish = (reason: string) =>
    (running ??= (end?.(reason) ?? Promise.resolve())
      .catch((error: unknown) => {
        log(`cleanup failed: ${String(error)}`);
      })
      .then(stopStarted));
  const exitAfter = (reason: string, code: number) => {
    void finish(reason).finally(() => process.exit(code));
  };
  process.on("SIGINT", () => {
    exitAfter("sigint", 130);
  });
  process.on("SIGTERM", () => {
    exitAfter("sigterm", 143);
  });
  if (timeoutMs !== null)
    setTimeout(() => {
      log(`hard timeout after ${timeoutMs / 1000}s`);
      exitAfter("hard_timeout", 2);
    }, timeoutMs).unref();
  return finish;
}

/** The ffmpeg command: the `FFMPEG` environment variable when set, else `ffmpeg` on PATH. */
export function ffmpegCommand(): string {
  const configured = process.env.FFMPEG;
  return configured === undefined || configured === "" ? "ffmpeg" : configured;
}

/** The ffprobe beside the ffmpeg command. */
export function ffprobeCommand(): string {
  return ffmpegCommand().replace(/ffmpeg$/, "ffprobe");
}

let ffmpegRuns: boolean | null = null;

/** Whether the ffmpeg command runs, checked once with `-version`. */
export function ffmpegAvailable(): boolean {
  ffmpegRuns ??= (() => {
    try {
      execFileSync(ffmpegCommand(), ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  return ffmpegRuns;
}
