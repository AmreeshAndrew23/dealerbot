import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";

/** Object storage for media and evidence. Local disk in development; S3 in production. */
export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string) {}
  private resolve(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data, { flag: "wx" }).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    });
  }
  get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch(() => undefined);
  }
}

/** Keys are always prefixed by tenant so access can be scoped per tenant. */
export function mediaKey(tenantId: string, mediaId: string, ext: string, now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `t/${tenantId}/media/${yyyy}/${mm}/${mediaId}${ext}`;
}
