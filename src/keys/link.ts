/** The URL fragment parameter that carries linked keys. */
export const linkParameter = "keys";

/**
 * A URL that carries keys in its fragment, which browsers never send to a server. Opening it saves
 * the keys in that browser and strips them from the address bar.
 */
export function linkWithKeys(base: string, keys: Record<string, string>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(keys));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${base}#${linkParameter}=${encoded}`;
}

/** The JSON text a link's fragment value carries. */
export function decodeLinkedKeys(encoded: string): string {
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
