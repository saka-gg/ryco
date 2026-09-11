import { extname } from "node:path";
import { Effect } from "effect";
import {
  PROJECT_ICON_MAX_BYTES,
  type OrchestrationProjectShell,
  type ProjectReadIconResult,
} from "@ryco/contracts";
import type { ProjectFaviconResolverShape } from "./Services/ProjectFaviconResolver.ts";
import type { ProjectAvatarStoreShape } from "./Services/ProjectAvatarStore.ts";

const iconTypes: Record<string, NonNullable<ProjectReadIconResult>["mimeType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Resolve only the registered project's artwork; callers cannot supply filesystem paths. */
export function readProjectIcon(
  project: Pick<OrchestrationProjectShell, "id" | "workspaceRoot" | "customAvatarContentHash">,
  services: { favicon: ProjectFaviconResolverShape | null; avatar: ProjectAvatarStoreShape | null },
): Effect.Effect<ProjectReadIconResult> {
  return Effect.gen(function* () {
    if (project.customAvatarContentHash && services.avatar) {
      const avatar = yield* services.avatar.read(project.id);
      if (avatar && avatar.bytes.length <= PROJECT_ICON_MAX_BYTES) {
        return { mimeType: "image/png" as const, dataBase64: avatar.bytes.toString("base64") };
      }
    }
    const icon = services.favicon ? yield* services.favicon.readIcon(project.workspaceRoot) : null;
    if (!icon || icon.bytes.length > PROJECT_ICON_MAX_BYTES) return null;
    const mimeType = iconTypes[extname(icon.path).toLowerCase()];
    return mimeType ? { mimeType, dataBase64: Buffer.from(icon.bytes).toString("base64") } : null;
  });
}
