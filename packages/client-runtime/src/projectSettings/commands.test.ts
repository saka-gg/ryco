import { CommandId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectAvatarSetCommand,
  buildProjectDeleteCommand,
  buildProjectMetaUpdateCommand,
} from "./commands.ts";

const commandId = CommandId.make("cmd-1");
const projectId = ProjectId.make("project-1");

describe("project commands", () => {
  it("carries only the fields that change", () => {
    expect(buildProjectMetaUpdateCommand({ commandId, projectId, patch: {} })).toEqual({
      type: "project.meta.update",
      commandId,
      projectId,
    });
    expect(
      buildProjectMetaUpdateCommand({
        commandId,
        projectId,
        patch: { customSystemPrompt: null, preferredRemoteName: "upstream", scripts: [] },
      }),
    ).toEqual({
      type: "project.meta.update",
      commandId,
      projectId,
      customSystemPrompt: null,
      preferredRemoteName: "upstream",
      scripts: [],
    });
  });

  it("resets the image and removes the project", () => {
    expect(buildProjectAvatarSetCommand({ commandId, projectId, contentHash: null })).toEqual({
      type: "project.avatar.set",
      commandId,
      projectId,
      contentHash: null,
    });
    expect(buildProjectDeleteCommand({ commandId, projectId })).toEqual({
      type: "project.delete",
      commandId,
      projectId,
    });
    expect(buildProjectDeleteCommand({ commandId, projectId, force: true }).force).toBe(true);
  });
});
