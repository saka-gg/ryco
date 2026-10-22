import { Effect, Layer, Stream } from "effect";

import { ProjectImports } from "../Services/ProjectImports.ts";
import { notAvailableYet } from "./notAvailableYet.ts";

/** Stands in for the live import job; every call fails "not available yet". */
export const ProjectImportsPlaceholder = Layer.succeed(
  ProjectImports,
  ProjectImports.of({
    start: () => Effect.fail(notAvailableYet()),
    get: () => Effect.fail(notAvailableYet()),
    subscribe: () => Stream.fail(notAvailableYet()),
    cancel: () => Effect.fail(notAvailableYet()),
    list: () => Effect.fail(notAvailableYet()),
    discard: () => Effect.fail(notAvailableYet()),
    recoverOnStartup: () => Effect.void,
  }),
);
