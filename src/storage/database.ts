import { record } from "../run-log/index.ts";

const databaseName = "vibe-ui";
const version = 4;

/** Object stores: keyed blobs and records that outlive a reload. */
export const stores = ["frames", "assets", "captures", "scenarios", "moments"] as const;
export type StoreName = (typeof stores)[number];

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of Array.from(database.objectStoreNames))
        if (!stores.some((store) => store === name)) database.deleteObjectStore(name);
      for (const name of stores)
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      record("storage_failed", { operation: "open", message: String(request.error) });
      resolve(null);
    };
  });
  return opening;
}

/** Stores a value under a key; never throws, logs `storage_failed` instead. */
export async function put(store: StoreName, key: string, value: unknown): Promise<void> {
  const database = await open();
  if (database === null) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      record("storage_failed", { operation: "put", store, message: String(transaction.error) });
      resolve();
    };
  });
}

/** Reads the raw value under a key, or undefined; callers parse it. */
export async function get(store: StoreName, key: string): Promise<unknown> {
  const database = await open();
  if (database === null) return undefined;
  return new Promise((resolve) => {
    const request = database.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      resolve(undefined);
    };
  });
}

/** Every key in a store that starts with a prefix, in key order. */
export async function keys(store: StoreName, prefix = ""): Promise<string[]> {
  const database = await open();
  if (database === null) return [];
  return new Promise((resolve) => {
    const request = database.transaction(store).objectStore(store).getAllKeys();
    request.onsuccess = () => {
      resolve(
        request.result
          .flatMap((key) => (typeof key === "string" ? [key] : []))
          .filter((key) => key.startsWith(prefix)),
      );
    };
    request.onerror = () => {
      resolve([]);
    };
  });
}

/** Deletes keys from a store in one transaction; never throws, logs `storage_failed` instead. */
export async function remove(store: StoreName, keys: readonly string[]): Promise<void> {
  const database = await open();
  if (database === null || keys.length === 0) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(store, "readwrite");
    for (const key of keys) transaction.objectStore(store).delete(key);
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      record("storage_failed", { operation: "remove", store, message: String(transaction.error) });
      resolve();
    };
  });
}
