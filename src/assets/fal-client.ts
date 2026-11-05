/**
 * Where fal calls go: fal itself with the visitor's own key, or this site's hosted route
 * (`key` null), which adds its own. `fetch` sends each call, and for the hosted route carries
 * its pass.
 */
export interface FalAccess {
  baseURL: string;
  key: string | null;
  fetch: typeof fetch;
}

/**
 * Calls one fal model, straight from the browser or a script with a key, or through the hosted
 * route, and returns its JSON answer for the caller's schema. Throws on any HTTP error with its
 * text.
 */
export async function falCall(
  access: FalAccess,
  model: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await access.fetch(`${access.baseURL}/${model}`, {
    method: "POST",
    headers: {
      ...(access.key === null ? {} : { Authorization: `Key ${access.key}` }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok)
    throw new Error(`${model} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result: unknown = await response.json();
  return result;
}

/** Downloads one file a fal model made. */
export async function falDownload(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`download HTTP ${response.status}`);
  return response.blob();
}
