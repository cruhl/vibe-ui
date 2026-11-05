import { z } from "zod";
import { json, overLimit, readJSON, reply, type Environment } from "./http.ts";

const maxWorldBytes = 160 * 1024;
const keepSeconds = 180 * 24 * 60 * 60;
const WorldID = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/);

const SharedWorld = z.strictObject({
  id: WorldID,
  idea: z.string().min(1).max(600),
  createdAt: z.string().max(40),
  files: z.strictObject({
    premise: z.string().min(1).max(40_000),
    world: z.looseObject({ canon: z.looseObject({ name: z.string().min(1).max(120) }) }),
    busy: z.looseObject({}).nullable(),
  }),
});

const key = (id: string) => `world/${id}`;

/**
 * `/api/worlds`: the shared store of written worlds, so a link opens a world anywhere. POST
 * stores one world's files (at most 160 KiB) under its id once, and the first writer of an id
 * keeps it; GET `/api/worlds/<id>` reads it back. Kept 180 days. Only the world's text is kept:
 * never its art, moments or anything about who wrote it.
 */
export async function worldsRoute(environment: Environment, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const limited = await overLimit(environment.LIMIT_WORLDS, request);
  if (limited !== null) return limited;
  if (pathname === "/api/worlds" && request.method === "POST") {
    const body = await readJSON(request, maxWorldBytes, SharedWorld);
    if ("failed" in body) return body.failed;
    const { id } = body.value;
    const existing = await environment.WORLDS.get(key(id));
    if (existing === null)
      await environment.WORLDS.put(key(id), JSON.stringify(body.value), {
        expirationTtl: keepSeconds,
      });
    return json(200, { id, stored: existing === null });
  }
  const id = WorldID.safeParse(pathname.slice("/api/worlds/".length));
  if (request.method !== "GET" || !pathname.startsWith("/api/worlds/") || !id.success)
    return reply(404, "Not found");
  const stored = await environment.WORLDS.get(key(id.data));
  return stored === null
    ? reply(404, "No world with that id")
    : new Response(stored, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
}
