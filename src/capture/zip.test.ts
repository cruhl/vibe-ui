import { describe, expect, test } from "vitest";
import { zip } from "./zip.ts";

interface Entry {
  name: string;
  crc: number;
  text: string;
}

/** Reads an archive the way an unzip tool does: from the end record, through the central directory. */
function read(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  expect(cursor + view.getUint32(end + 12, true)).toBe(end);
  return Array.from({ length: count }, () => {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const local = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength;
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint16(local + 26, true)).toBe(nameLength);
    const start = local + 30 + nameLength;
    return { name, crc, text: decoder.decode(bytes.subarray(start, start + size)) };
  });
}

describe("zip", () => {
  test("writes every file whole, in order, under its path, with its CRC-32", async () => {
    const archive = await zip(
      new Map([
        ["world/premise.md", new Blob(["123456789"])],
        ["world/busy/notes.txt", new Blob(["a second file"])],
        ["world/empty.json", new Blob([])],
      ]),
    );
    expect(archive.type).toBe("application/zip");
    const entries = read(new Uint8Array(await archive.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual([
      "world/premise.md",
      "world/busy/notes.txt",
      "world/empty.json",
    ]);
    expect(entries[0]).toEqual({ name: "world/premise.md", crc: 0xcbf43926, text: "123456789" });
    expect(entries[1]?.text).toBe("a second file");
    expect(entries[2]).toEqual({ name: "world/empty.json", crc: 0, text: "" });
  });

  test("an empty archive is only its end record", async () => {
    const archive = await zip(new Map());
    expect(read(new Uint8Array(await archive.arrayBuffer()))).toEqual([]);
  });
});
