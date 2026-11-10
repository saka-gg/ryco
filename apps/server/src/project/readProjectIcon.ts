import { createHash } from "node:crypto";
import { extname } from "node:path";
import { Effect } from "effect";
import {
  PROJECT_ICON_MAX_BYTES,
  ProjectReadIconError,
  type OrchestrationProjectShell,
  type ProjectReadIconResult,
} from "@ryco/contracts";
import type { ProjectFaviconResolverShape } from "./Services/ProjectFaviconResolver.ts";
import type { ProjectAvatarStoreShape } from "./Services/ProjectAvatarStore.ts";

type ProjectIconMimeType = Extract<
  NonNullable<ProjectReadIconResult>,
  { mimeType: string }
>["mimeType"];

const iconTypes: Record<string, ProjectIconMimeType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const contentHashes = new WeakMap<Uint8Array, string>();

/**
 * Names a project icon's bytes, for HTTP validators and the icon RPC's
 * `knownHash`. Memoized per buffer: the favicon resolver hands out the same
 * bytes until the icon changes.
 */
export function projectIconContentHash(bytes: Uint8Array): string {
  const known = contentHashes.get(bytes);
  if (known !== undefined) return known;
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  contentHashes.set(bytes, hash);
  return hash;
}

/**
 * Resolve only the registered project's artwork; callers cannot supply
 * filesystem paths. `null` means the project has no artwork; a read that did
 * not finish fails instead, so clients retry rather than remember an absence.
 * A `knownHash` naming the artwork found is answered `{ unchanged: true }`.
 */
export function readProjectIcon(
  project: Pick<OrchestrationProjectShell, "id" | "workspaceRoot" | "customAvatarContentHash">,
  services: { favicon: ProjectFaviconResolverShape | null; avatar: ProjectAvatarStoreShape | null },
  knownHash?: string,
): Effect.Effect<ProjectReadIconResult, ProjectReadIconError> {
  const answer = (
    mimeType: ProjectIconMimeType,
    bytes: Uint8Array,
    hash: string,
  ): ProjectReadIconResult =>
    hash === knownHash
      ? { unchanged: true }
      : { mimeType, dataBase64: Buffer.from(bytes).toString("base64"), hash };
  return Effect.gen(function* () {
    if (project.customAvatarContentHash && services.avatar) {
      const avatar = yield* services.avatar.read(project.id);
      if (avatar && avatar.bytes.length <= PROJECT_ICON_MAX_BYTES) {
        return answer("image/png", avatar.bytes, `a${avatar.contentHash.slice(0, 32)}`);
      }
    }
    const icon = services.favicon
      ? yield* services.favicon
          .readIcon(project.workspaceRoot)
          .pipe(
            Effect.mapError(
              () => new ProjectReadIconError({ message: "Project artwork is not available yet." }),
            ),
          )
      : null;
    if (!icon || icon.bytes.length > PROJECT_ICON_MAX_BYTES) return null;
    const mimeType = iconTypes[extname(icon.path).toLowerCase()];
    return mimeType ? answer(mimeType, icon.bytes, projectIconContentHash(icon.bytes)) : null;
  });
}
