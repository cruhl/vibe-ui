import { captureFile } from "../capture/index.ts";
import { record } from "../run-log/index.ts";
import { get, keys, put } from "../storage/index.ts";
import { z } from "zod";

/** Where an asset's picture came from. */
export type AssetSource = "final-frame" | "crop" | "generate" | "preset";

export const AssetMeta = z.object({
  label: z.string(),
  description: z.string(),
  source: z.enum(["final-frame", "crop", "generate", "preset"]),
  wholeFrame: z.boolean(),
  clipID: z.string().nullable(),
  scene: z.string().nullable(),
  degradation: z.number().nullable(),
  createdAt: z.string(),
});
export type AssetMeta = z.infer<typeof AssetMeta>;

/** A picture of one thing in the world, labelled by its entity id, used as a reference image. */
export interface Asset extends AssetMeta {
  image: Blob;
}

const Stored = z.object({ meta: AssetMeta, image: z.instanceof(Blob) });
const labelPattern = /@([a-z][a-z0-9]*(?:[-.][a-z0-9]+)*)/g;

/** A prompt with its @labels expanded, and the pictures it now names, in order. */
export interface Expanded {
  prompt: string;
  references: Asset[];
}

/**
 * The pictures of one session's world, labelled by entity id: kept in memory, backed by
 * IndexedDB under the session's scope, and in dev written to the session bundle. Newest wins per
 * label. A session never sees another session's pictures, because ids are only stable within one.
 */
export class AssetLibrary {
  private readonly assets = new Map<string, Asset>();
  private readonly listeners = new Set<(asset: Asset) => void>();

  constructor(private readonly scope: string) {}

  /** Loads every stored picture of this scope. */
  async load(): Promise<void> {
    for (const key of await keys("assets", `${this.scope}/`)) {
      const stored = Stored.safeParse(await get("assets", key));
      if (stored.success)
        this.assets.set(stored.data.meta.label, { ...stored.data.meta, image: stored.data.image });
    }
    record("assets_loaded", { count: this.assets.size, labels: [...this.assets.keys()] });
  }

  add(asset: Asset): void {
    this.assets.set(asset.label, asset);
    const { image, ...meta } = asset;
    void put("assets", `${this.scope}/${asset.label}`, { meta, image });
    captureFile(`assets/${asset.label}.jpg`, image);
    captureFile(`assets/${asset.label}.json`, JSON.stringify(meta, null, 2));
    record("asset_added", { ...meta, bytes: image.size });
    for (const listener of this.listeners) listener(asset);
  }

  /** Calls `listener` with every picture added from now on; returns its removal. */
  onAdded(listener: (asset: Asset) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every picture held now. */
  images(): Blob[] {
    return [...this.assets.values()].map((asset) => asset.image);
  }

  get(label: string): Asset | null {
    return this.assets.get(label.replace(/^@/, "")) ?? null;
  }

  has(label: string): boolean {
    return this.assets.has(label);
  }

  /**
   * Expands each @label into a picture reference with its description. At most `limit` pictures
   * are attached; any further label keeps only its description, so the request stays on a
   * reference count the model has warmed. A label the library does not hold is rejected.
   */
  expand(prompt: string, limit = 1): Expanded {
    const references: Asset[] = [];
    const definitions: string[] = [];
    const body = prompt.replace(labelPattern, (_whole, label: string) => {
      const asset = this.assets.get(label);
      if (asset === undefined) {
        record("asset_label_unknown", { label });
        throw new Error(`unknown picture label @${label}`);
      }
      const index = references.indexOf(asset);
      if (index !== -1) return `<Picture ${index + 1}>`;
      if (references.length >= limit) return asset.description;
      references.push(asset);
      definitions.push(`<Picture ${references.length}> is ${asset.description}.`);
      return `<Picture ${references.length}>`;
    });
    return {
      prompt:
        definitions.length === 0
          ? body
          : `subject_definitions:\n${definitions.join("\n")}\n\n${body}`,
      references,
    };
  }
}
