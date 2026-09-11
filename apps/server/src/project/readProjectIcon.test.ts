import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Option } from "effect";
import { PROJECT_ICON_MAX_BYTES, ProjectId, WS_METHODS } from "@ryco/contracts";
import { readProjectIcon } from "./readProjectIcon.ts";
import { makeProjectHandlers } from "../ws/projectRpc.ts";
import type { WsRpcContext } from "../ws/context.ts";

const project = {
  id: ProjectId.make("project"),
  workspaceRoot: "/workspace/project",
  customAvatarContentHash: null,
};
const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

describe("project artwork over RPC", () => {
  it("reads detected artwork only from the registered project root", async () => {
    const readIcon = vi.fn(() => Effect.succeed({ path: "/workspace/project/favicon.svg", bytes }));
    expect(
      await Effect.runPromise(readProjectIcon(project, { favicon: { readIcon }, avatar: null })),
    ).toEqual({ mimeType: "image/svg+xml", dataBase64: bytes.toString("base64") });
    expect(readIcon).toHaveBeenCalledWith(project.workspaceRoot);
  });
  it("prefers custom avatars and falls back when they are missing", async () => {
    const readIcon = vi.fn(() => Effect.succeed({ path: "favicon.svg", bytes }));
    const read = vi.fn(() => Effect.succeed({ bytes, contentHash: "avatar" }));
    const services = { favicon: { readIcon }, avatar: { read, write: vi.fn(), remove: vi.fn() } };
    expect(
      await Effect.runPromise(
        readProjectIcon({ ...project, customAvatarContentHash: "avatar" }, services),
      ),
    ).toMatchObject({ mimeType: "image/png" });
    expect(readIcon).not.toHaveBeenCalled();
    expect(
      await Effect.runPromise(
        readProjectIcon(
          { ...project, customAvatarContentHash: "missing" },
          { ...services, avatar: { ...services.avatar, read: () => Effect.succeed(null) } },
        ),
      ),
    ).toMatchObject({ mimeType: "image/svg+xml" });
  });
  it("bounds content and rejects non-image extensions", async () => {
    for (const icon of [
      null,
      { path: "secret.txt", bytes },
      { path: "big.png", bytes: Buffer.alloc(PROJECT_ICON_MAX_BYTES + 1) },
    ]) {
      expect(
        await Effect.runPromise(
          readProjectIcon(project, {
            favicon: { readIcon: () => Effect.succeed(icon) },
            avatar: null,
          }),
        ),
      ).toBeNull();
    }
  });
  it("returns no artwork for unknown/deleted projects and authorizes the read first", async () => {
    const lookup = vi.fn(() => Effect.succeed(Option.none()));
    const authorize = vi.fn((_role, _method, effect) => effect);
    const handlers = makeProjectHandlers({
      projectionSnapshotQuery: { getProjectShellById: lookup },
      withAccess: authorize,
    } as unknown as WsRpcContext);
    expect(
      await Effect.runPromise(
        handlers[WS_METHODS.projectsReadIcon]({ projectId: project.id }) as Effect.Effect<unknown>,
      ),
    ).toBeNull();
    expect(authorize).toHaveBeenCalledWith(
      "viewer",
      WS_METHODS.projectsReadIcon,
      expect.anything(),
    );
    expect(lookup).toHaveBeenCalledWith(project.id);
  });
});
