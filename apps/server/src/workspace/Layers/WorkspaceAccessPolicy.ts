import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  WorkspaceAccessDeniedError,
  WorkspaceAccessPolicy,
  type WorkspaceAccessPathInput,
  type WorkspaceAccessPolicyShape,
} from "../Services/WorkspaceAccessPolicy.ts";
import { isPathInside } from "../../pathContainment.ts";

function isWithinOrEqual(path: Path.Path, root: string, target: string): boolean {
  return isPathInside({ root, candidate: target, allowRoot: true, path });
}

export const makeWorkspaceAccessPolicy = (configuredRoot: string | undefined) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const accessRoot =
      configuredRoot === undefined ? undefined : yield* fileSystem.realPath(configuredRoot);

    const denied = (
      input: WorkspaceAccessPathInput,
      reason: "outsideRoot" | "unresolvable",
    ): WorkspaceAccessDeniedError =>
      new WorkspaceAccessDeniedError({
        operation: input.operation,
        requestedPath: input.path,
        accessRoot: accessRoot ?? "",
        reason,
      });

    const assertInside = (
      input: WorkspaceAccessPathInput,
      target: string,
    ): Effect.Effect<string, WorkspaceAccessDeniedError> => {
      if (accessRoot === undefined || isWithinOrEqual(path, accessRoot, target)) {
        return Effect.succeed(target);
      }
      return Effect.fail(denied(input, "outsideRoot"));
    };

    const assertExistingPath: WorkspaceAccessPolicyShape["assertExistingPath"] = Effect.fn(
      "WorkspaceAccessPolicy.assertExistingPath",
    )(function* (input) {
      const normalized = path.resolve(input.path);
      if (accessRoot === undefined) return normalized;
      const canonical = yield* fileSystem
        .realPath(normalized)
        .pipe(Effect.mapError(() => denied(input, "unresolvable")));
      return yield* assertInside(input, canonical);
    });

    const assertPath: WorkspaceAccessPolicyShape["assertPath"] = Effect.fn(
      "WorkspaceAccessPolicy.assertPath",
    )(function* (input) {
      const normalized = path.resolve(input.path);
      if (accessRoot === undefined) return normalized;

      let ancestor = normalized;
      while (!(yield* fileSystem.exists(ancestor).pipe(Effect.orElseSucceed(() => false)))) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          return yield* denied(input, "unresolvable");
        }
        ancestor = parent;
      }

      const canonicalAncestor = yield* fileSystem
        .realPath(ancestor)
        .pipe(Effect.mapError(() => denied(input, "unresolvable")));
      const canonicalTarget = path.resolve(canonicalAncestor, path.relative(ancestor, normalized));
      return yield* assertInside(input, canonicalTarget);
    });

    return {
      accessRoot,
      isRestricted: accessRoot !== undefined,
      assertPath,
      assertExistingPath,
    } satisfies WorkspaceAccessPolicyShape;
  });

export const WorkspaceAccessPolicyLive = Layer.effect(
  WorkspaceAccessPolicy,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeWorkspaceAccessPolicy(config.workspaceAccessRoot);
  }),
);

export const WorkspaceAccessPolicyLayer = (accessRoot: string | undefined) =>
  Layer.effect(WorkspaceAccessPolicy, makeWorkspaceAccessPolicy(accessRoot));
