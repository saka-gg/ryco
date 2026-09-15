// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - bounded verified model I/O.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { VOICE_MODEL } from "@ryco/shared/voice";

export const modelPath = (directory: string) => join(directory, "whisper-tiny-Q8_0.gguf");
async function verifyModel(directory: string) {
  const path = modelPath(directory);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== VOICE_MODEL.bytes) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex") === VOICE_MODEL.sha256;
}
export async function installModel(directory: string, signal: AbortSignal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const partial = join(directory, "model.part");
  const file = await open(partial, "w", 0o600);
  try {
    const response = await fetch(VOICE_MODEL.url, { signal });
    if (!response.ok || !response.body) throw new Error("Model download failed.");
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let count = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        if (count > VOICE_MODEL.bytes) throw new Error("Model exceeds its declared size.");
        hash.update(value);
        await file.writeFile(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (count !== VOICE_MODEL.bytes || hash.digest("hex") !== VOICE_MODEL.sha256)
      throw new Error("Model checksum verification failed.");
    signal.throwIfAborted();
    await file.sync();
    await file.close();
    await rename(partial, modelPath(directory));
  } finally {
    await file.close().catch(() => {});
    await rm(partial, { force: true });
  }
}

/** One verification at a time, cached only for the same filesystem identity. */
export function createModelReadiness(directory: string) {
  let verified: string | null = null;
  let pending: Promise<boolean> | null = null;
  const identity = async () => {
    const info = await stat(modelPath(directory), { bigint: true }).catch(() => null);
    return info?.isFile()
      ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      : null;
  };
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const before = await identity();
      if (before && before === verified) return true;
      verified = null;
      if (!before || !(await verifyModel(directory))) return false;
      if ((await identity()) !== before) return false;
      verified = before;
      return true;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
