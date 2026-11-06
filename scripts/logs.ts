import { z } from "zod";
import { cloudflareCredentials } from "./plumbing.ts";

const usage = `pnpm logs <session-id> [--json] [--env-file <path>]
pnpm logs failing [--limit <n>] [--env-file <path>]
pnpm logs setup [--env-file <path>]

Reads the deployment's logs through the Cloudflare API. Every page sends its run log to the
Worker's /api/log, which keeps it in the R2 bucket vibe-ui-logs under sessions/<session-id>/, and
the Worker writes one structured line per request, and one per run-log event, to Workers Logs. A
session id is the page's run id: the debug panel and a failure's Details show it.

<session-id>   prints that session's whole log, oldest first: every run-log event the page sent
               (R2, kept 30 days) merged with every Worker line that names the session (Workers
               Logs, kept 7 days): route, status, latency, pass, budget decisions, upstream calls
               with status and timing, and scrubbed failure bodies
failing        lists the sessions most recently marked failing (a run-log failure event, or a
               hosted route answering 4xx or 5xx past its pass), newest first, with the reason
setup          creates the bucket when it is missing and sets its lifecycle rule, which deletes
               every object 30 days after it was written; safe to run again

--json         one JSON object per line instead of the readable form
--limit        how many failing sessions to list (default 20)
--env-file     a dotenv file to read CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from;
               nothing else in it is read, and neither is ever printed. Without it the process
               environment is used. The token needs R2 edit and Workers observability read.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.length === 0) {
  process.stdout.write(`${usage}\n`);
  process.exit(argv.length === 0 ? 1 : 0);
}
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const optionValues = new Set(["--limit", "--env-file"].map((name) => option(name.slice(2))));
const [command = ""] = argv.filter(
  (argument) => !argument.startsWith("--") && !optionValues.has(argument),
);
const asJSON = argv.includes("--json");
const bucket = "vibe-ui-logs";
const service = "vibe-ui";
const retentionSeconds = 30 * 24 * 60 * 60;
const workersLogsDays = 7;

const fail = (message: string): never => {
  process.stderr.write(`logs: ${message}\n`);
  process.exit(1);
};

const credentials = (() => {
  try {
    return cloudflareCredentials(option("env-file"));
  } catch (error: unknown) {
    return fail(String(error));
  }
})();
const token = credentials.CLOUDFLARE_API_TOKEN ?? fail("no CLOUDFLARE_API_TOKEN");
const account = credentials.CLOUDFLARE_ACCOUNT_ID ?? fail("no CLOUDFLARE_ACCOUNT_ID");
const api = `https://api.cloudflare.com/client/v4/accounts/${account}`;

const Envelope = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string() })).default([]),
  result: z.unknown(),
  result_info: z.looseObject({ cursor: z.string().optional() }).optional(),
});

async function call(path: string, init: RequestInit = {}): Promise<z.infer<typeof Envelope>> {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const parsed = Envelope.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return fail(`${path} answered HTTP ${String(response.status)}`);
  if (!parsed.data.success)
    return fail(`${path}: ${parsed.data.errors.map((error) => error.message).join("; ")}`);
  return parsed.data;
}

const R2Object = z.looseObject({ key: z.string(), last_modified: z.string() });
type R2Object = z.infer<typeof R2Object>;

async function listObjects(prefix: string): Promise<R2Object[]> {
  const found: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ prefix, per_page: "1000" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const answer = await call(`/r2/buckets/${bucket}/objects?${query.toString()}`);
    const page = z.array(R2Object).parse(answer.result);
    found.push(...page);
    cursor = page.length === 0 ? undefined : answer.result_info?.cursor;
  } while (cursor !== undefined && cursor !== "");
  return found;
}

async function readObject(key: string): Promise<string> {
  const response = await fetch(
    `${api}/r2/buckets/${bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) return fail(`reading ${key} answered HTTP ${String(response.status)}`);
  return response.text();
}

const TelemetryEvent = z.looseObject({
  timestamp: z.number(),
  source: z.unknown(),
});

const Telemetry = z.object({
  events: z.object({ events: z.array(TelemetryEvent).default([]) }).optional(),
});

const telemetryLimit = 2000;

async function workerLines(session: string, from: number, to: number): Promise<LogLine[]> {
  const answer = await call("/workers/observability/telemetry/query", {
    method: "POST",
    body: JSON.stringify({
      queryId: "vibe-ui-logs",
      timeframe: { from, to },
      view: "events",
      limit: telemetryLimit,
      parameters: {
        filters: [
          { key: "$metadata.service", operation: "eq", type: "string", value: service },
          { key: "session", operation: "eq", type: "string", value: session },
          { key: "log", operation: "eq", type: "string", value: "worker" },
        ],
      },
    }),
  });
  const events = Telemetry.parse(answer.result).events?.events ?? [];
  if (events.length >= telemetryLimit && to - from > 1000) {
    const middle = Math.floor((from + to) / 2);
    return [
      ...(await workerLines(session, from, middle)),
      ...(await workerLines(session, middle, to)),
    ];
  }
  return events.flatMap((event) => {
    const fields = z.record(z.string(), z.unknown()).safeParse(event.source);
    return fields.success ? [{ at: event.timestamp, source: "worker", fields: fields.data }] : [];
  });
}

interface LogLine {
  at: number;
  source: "client" | "worker";
  fields: Record<string, unknown>;
}

const ClientEvent = z.looseObject({ kind: z.string(), at: z.string().optional() });

function clientLines(text: string): LogLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const event = ClientEvent.parse(JSON.parse(line));
        const at = event.at === undefined ? Number.NaN : Date.parse(event.at);
        return [{ at, source: "client" as const, fields: event }];
      } catch {
        return [];
      }
    });
}

const clock = (at: number) =>
  Number.isNaN(at) ? "--:--:--.---" : new Date(at).toISOString().slice(11, 23);

function readable(line: LogLine): string {
  const fields = line.fields;
  if (line.source === "client") {
    const { kind, at: _at, t: _t, ...rest } = fields;
    return `${clock(line.at)}  page    ${String(kind)}  ${JSON.stringify(rest)}`;
  }
  const {
    log: _log,
    route,
    method,
    status,
    milliseconds,
    session: _session,
    visitor,
    ...rest
  } = fields;
  return `${clock(line.at)}  worker  ${String(method)} ${String(route)} ${String(status)} ${String(milliseconds)}ms visitor ${String(visitor)}  ${JSON.stringify(rest)}`;
}

async function pullSession(session: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(session)) fail(`${session} is not a session id`);
  const objects = await listObjects(`sessions/${session}/`);
  const texts = await Promise.all(objects.map((object) => readObject(object.key)));
  const client = texts.flatMap(clientLines);
  const now = Date.now();
  const stamps = [
    ...objects.map((object) => Date.parse(object.last_modified)),
    ...client.map((line) => line.at),
  ].filter((value) => !Number.isNaN(value));
  const from = Math.max(
    now - workersLogsDays * 24 * 60 * 60 * 1000,
    stamps.length === 0 ? 0 : Math.min(...stamps) - 30 * 60 * 1000,
  );
  const to = stamps.length === 0 ? now : Math.min(now, Math.max(...stamps) + 30 * 60 * 1000);
  const worker = from < to ? await workerLines(session, from, to) : [];
  if (client.length === 0 && worker.length === 0) fail(`nothing logged for ${session}`);
  const merged = [...client, ...worker].sort((left, right) => left.at - right.at);
  for (const line of merged)
    process.stdout.write(
      `${asJSON ? JSON.stringify({ at: new Date(line.at).toISOString(), source: line.source, ...line.fields }) : readable(line)}\n`,
    );
  process.stderr.write(
    `${session}: ${String(client.length)} page events in ${String(objects.length)} batches, ${String(worker.length)} worker lines\n`,
  );
}

const Marker = z.looseObject({ session: z.string(), reason: z.string(), at: z.string() });

async function listFailing(): Promise<void> {
  const limit = Number(option("limit") ?? "20");
  const newest = (await listObjects("failing/"))
    .sort((left, right) => right.last_modified.localeCompare(left.last_modified))
    .slice(0, Number.isInteger(limit) && limit > 0 ? limit : 20);
  const markers = await Promise.all(
    newest.map(async (object) => Marker.safeParse(JSON.parse(await readObject(object.key)))),
  );
  for (const marker of markers)
    if (marker.success)
      process.stdout.write(
        asJSON
          ? `${JSON.stringify(marker.data)}\n`
          : `${marker.data.at}  ${marker.data.session}  ${marker.data.reason}\n`,
      );
  if (newest.length === 0) process.stderr.write("no failing sessions in the last 30 days\n");
}

async function setup(): Promise<void> {
  const buckets = z
    .object({ buckets: z.array(z.object({ name: z.string() })) })
    .parse((await call("/r2/buckets")).result);
  if (!buckets.buckets.some((entry) => entry.name === bucket)) {
    await call("/r2/buckets", { method: "POST", body: JSON.stringify({ name: bucket }) });
    process.stdout.write(`created ${bucket}\n`);
  }
  await call(`/r2/buckets/${bucket}/lifecycle`, {
    method: "PUT",
    body: JSON.stringify({
      rules: [
        {
          id: "expire-30-days",
          enabled: true,
          conditions: { prefix: "" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: retentionSeconds } },
        },
      ],
    }),
  });
  process.stdout.write(`${bucket} deletes every object 30 days after it is written\n`);
}

if (command === "setup") await setup();
else if (command === "failing") await listFailing();
else await pullSession(command);
