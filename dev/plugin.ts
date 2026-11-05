import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { z } from "zod";
import { readLocalEnvironment } from "./environment.ts";

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Whether a dev endpoint request came from this dev server's own page or from a script: a page on
 * another site can post to localhost without reading the answer, so a browser's cross-site
 * request (an `Origin` other than this host, or `Sec-Fetch-Site` other than same-origin or none)
 * is refused before any file is read or written.
 */
function ownRequest(request: IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

const RunBatch = z.object({
  runID: z.string().regex(/^[A-Za-z0-9._-]+$/),
  events: z.array(z.record(z.string(), z.unknown())),
});

function readBytes(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

const readBody = async (request: IncomingMessage) => (await readBytes(request)).toString("utf8");

const CaptureQuery = z.object({
  runID: z.string().regex(/^[A-Za-z0-9._-]+$/),
  name: z
    .string()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .refine((name) => !name.includes("..")),
  append: z.enum(["0", "1"]),
});

const BakeQuery = z.union([
  z.object({
    scenario: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().regex(/^(?:[0-9a-f]{16}\.(?:mp4|jpg)|tree\.json)$/),
    place: z.literal("moments").default("moments"),
  }),
  z.object({
    scenario: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().regex(/^(?:premise\.md|world\.json|busy\.md|busy\/[a-z0-9][a-z0-9._-]*)$/),
    place: z.literal("folder"),
  }),
]);

/**
 * Dev-only endpoints. `/__dev/build` answers the commit and whether tracked files differ from it,
 * read at request time so each page load stamps the code it really ran. `/__dev/keys` serves
 * `.env.local` as prefill for the keys screen, to loopback clients only, so `vite --host` never
 * hands the keys to the LAN. `/__dev/runs` appends run-log batches to `.agent/runs/<runID>.jsonl`
 * and the session bundle, and `/__dev/capture` writes or appends a bundle file under
 * `.agent/sessions/<runID>/` (the recording also to `.agent/recordings/<runID>.webm`, assets also
 * to `.agent/assets/`). `/__dev/bake` writes one baked file (a moment's clip or held frame, or
 * `tree.json`) into an existing scenario folder's `moments/`, or with `place=folder` a written
 * scenario's own files (premise, world, busy state and art) into a new folder, for
 * `scripts/bake.ts`. `/__dev/kit/<runID>/<file>` serves a replay kit built by
 * `scripts/replay-kit.ts` from `.agent/design/kits/`. Every endpoint refuses a browser's
 * cross-site request, so another site open in the same browser can neither write files nor read
 * them. Applied only by `vite serve`, so no endpoint and no value exists in a production build.
 */
export function devPlugin(root: string): Plugin {
  return {
    name: "vibe-ui-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev", (request, response, next) => {
        if (ownRequest(request)) {
          next();
          return;
        }
        response.statusCode = 403;
        response.end();
      });
      server.middlewares.use("/__dev/keys", (request, response) => {
        if (!loopback.has(request.socket.remoteAddress ?? "")) {
          response.statusCode = 403;
          response.end();
          return;
        }
        const environment = readLocalEnvironment(join(root, ".env.local"));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(environment));
      });
      server.middlewares.use("/__dev/kit", (request, response) => {
        const name = decodeURIComponent((request.url ?? "").split("?")[0] ?? "").replace(/^\//, "");
        const path = join(root, ".agent", "design", "kits", name);
        if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes("..") || !existsSync(path)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const types: Record<string, string> = {
          json: "application/json",
          webm: "video/webm",
          jpg: "image/jpeg",
        };
        response.setHeader(
          "Content-Type",
          types[name.split(".").pop() ?? ""] ?? "application/octet-stream",
        );
        response.end(readFileSync(path));
      });
      server.middlewares.use("/__dev/build", (_request, response) => {
        const git = (...args: string[]) => {
          try {
            return execFileSync("git", args, { cwd: root }).toString().trim();
          } catch {
            return null;
          }
        };
        const changed = git("status", "--porcelain", "--untracked-files=no");
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            commit: git("rev-parse", "--short", "HEAD"),
            dirty: changed === null ? null : changed !== "",
            changedFiles: changed === null ? null : changed.split("\n").filter(Boolean).length,
          }),
        );
      });
      server.middlewares.use("/__dev/capture", (request, response) => {
        const query = CaptureQuery.safeParse(
          Object.fromEntries(new URL(request.url ?? "", "http://dev").searchParams),
        );
        if (request.method !== "POST" || !query.success) {
          response.statusCode = 400;
          response.end();
          return;
        }
        const { runID, name, append } = query.data;
        readBytes(request)
          .then((bytes) => {
            const path = join(root, ".agent", "sessions", runID, name);
            mkdirSync(dirname(path), { recursive: true });
            if (append === "1") appendFileSync(path, bytes);
            else writeFileSync(path, bytes);
            if (name.startsWith("assets/")) {
              const assets = join(root, ".agent", "assets");
              mkdirSync(assets, { recursive: true });
              writeFileSync(join(assets, name.slice("assets/".length)), bytes);
            }
            if (name === "recording.webm") {
              const recordings = join(root, ".agent", "recordings");
              mkdirSync(recordings, { recursive: true });
              appendFileSync(join(recordings, `${runID}.webm`), bytes);
            }
            response.statusCode = 204;
            response.end();
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      server.middlewares.use("/__dev/bake", (request, response) => {
        const query = BakeQuery.safeParse(
          Object.fromEntries(new URL(request.url ?? "", "http://dev").searchParams),
        );
        const folder = query.success ? join(root, "src", "presets", query.data.scenario) : null;
        if (
          request.method !== "POST" ||
          !query.success ||
          folder === null ||
          (query.data.place === "moments" && !existsSync(join(folder, "premise.md")))
        ) {
          response.statusCode = 400;
          response.end();
          return;
        }
        const { name, place } = query.data;
        readBytes(request)
          .then((bytes) => {
            const path = place === "folder" ? join(folder, name) : join(folder, "moments", name);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, bytes);
            response.statusCode = 204;
            response.end();
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      server.middlewares.use("/__dev/runs", (request, response) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end();
          return;
        }
        readBody(request)
          .then((body) => {
            const batch = RunBatch.parse(JSON.parse(body));
            const directory = join(root, ".agent", "runs");
            mkdirSync(directory, { recursive: true });
            const lines = batch.events.map((event) => JSON.stringify(event)).join("\n");
            if (lines.length > 0) {
              appendFileSync(join(directory, `${batch.runID}.jsonl`), `${lines}\n`);
              const session = join(root, ".agent", "sessions", batch.runID);
              mkdirSync(session, { recursive: true });
              appendFileSync(join(session, "run-log.jsonl"), `${lines}\n`);
            }
            response.statusCode = 204;
            response.end();
          })
          .catch((error: unknown) => {
            response.statusCode = 400;
            response.end(String(error));
          });
      });
    },
  };
}
