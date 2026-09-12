import path from "node:path";

import {
  AGENT_CONTROL_DEVICE_ACTION_KINDS,
  type AgentControlActionPlan,
  type AgentControlDeviceActionPlan,
} from "@ryco/contracts";
import { Effect } from "effect";

import type { WorkspaceAccessPolicyShape } from "../workspace/Services/WorkspaceAccessPolicy.ts";

const DEVICE_ACTION_KINDS = new Set<string>(AGENT_CONTROL_DEVICE_ACTION_KINDS);
const BLOCKED_URL_SCHEMES = new Set([
  "about:",
  "blob:",
  "chrome-extension:",
  "chrome:",
  "data:",
  "file:",
  "ftp:",
  "javascript:",
  "resource:",
]);

export class AgentControlDeviceInputError extends Error {
  readonly _tag = "AgentControlDeviceInputError";
}

export const isAgentControlDevicePlan = (
  plan: AgentControlActionPlan,
): plan is AgentControlDeviceActionPlan => DEVICE_ACTION_KINDS.has(plan.kind);

/** Validate without ever returning the URL in an error or diagnostic message. */
export const assertSafeAgentControlDeviceUrl = (value: string): void => {
  if (
    /\s/u.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new AgentControlDeviceInputError("The URL contains unsupported characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentControlDeviceInputError("The URL is not an absolute URL or deep link.");
  }
  if (BLOCKED_URL_SCHEMES.has(parsed.protocol.toLowerCase())) {
    throw new AgentControlDeviceInputError("This URL scheme is not permitted for device control.");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new AgentControlDeviceInputError("URLs with embedded credentials are not permitted.");
  }
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.hostname.length === 0
  ) {
    throw new AgentControlDeviceInputError("Network URLs must include a host.");
  }
};

/**
 * Turn the proposal's workspace-relative `.app` or `.apk` reference into an existing
 * canonical path, rejecting traversal and symlink escapes at proposal and
 * execution time.
 */
export const resolveAgentControlDeviceArtifact = (input: {
  readonly workspaceRoot: string;
  readonly artifactPath: string;
  readonly workspaceAccess: Pick<WorkspaceAccessPolicyShape, "assertExistingPath">;
}) =>
  Effect.gen(function* () {
    const segments = input.artifactPath.split("/");
    if (
      path.isAbsolute(input.artifactPath) ||
      input.artifactPath.startsWith("~") ||
      input.artifactPath.includes("\\") ||
      input.artifactPath.includes("\0") ||
      segments.includes("..") ||
      ![".app", ".apk"].includes(path.extname(input.artifactPath))
    ) {
      return yield* Effect.fail(
        new AgentControlDeviceInputError(
          "The application artifact must be a workspace-relative .app bundle or .apk file.",
        ),
      );
    }

    const canonicalWorkspace = yield* input.workspaceAccess.assertExistingPath({
      path: input.workspaceRoot,
      operation: "AgentControl.deviceArtifactWorkspace",
    });
    const canonicalArtifact = yield* input.workspaceAccess.assertExistingPath({
      path: path.resolve(canonicalWorkspace, input.artifactPath),
      operation: "AgentControl.deviceArtifact",
    });
    const relative = path.relative(canonicalWorkspace, canonicalArtifact);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      ![".app", ".apk"].includes(path.extname(canonicalArtifact))
    ) {
      return yield* Effect.fail(
        new AgentControlDeviceInputError(
          "The application artifact must resolve to a .app bundle or .apk file inside the project workspace.",
        ),
      );
    }
    return canonicalArtifact;
  });
