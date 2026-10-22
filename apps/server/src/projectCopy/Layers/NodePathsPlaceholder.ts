import { Effect, Layer } from "effect";

import { NodePaths } from "../Services/NodePaths.ts";
import { notAvailableYet } from "./notAvailableYet.ts";

/** Stands in for the live node paths service; every call fails "not available yet". */
export const NodePathsPlaceholder = Layer.succeed(
  NodePaths,
  NodePaths.of({
    pathHints: () => Effect.fail(notAvailableYet()),
    searchDirectories: () => Effect.fail(notAvailableYet()),
    previewDestination: () => Effect.fail(notAvailableYet()),
    judgeProjectDestination: () => Effect.fail(notAvailableYet()),
    resolveCodeRoots: () => Effect.fail(notAvailableYet()),
  }),
);
