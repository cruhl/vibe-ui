/** A 32-bit FNV-1a hash of a text, as 8 hex characters: stable names for content, not security. */
export function hashText(text: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
  return (value >>> 0).toString(16).padStart(8, "0");
}
