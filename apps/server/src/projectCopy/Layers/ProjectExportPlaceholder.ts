import { Effect, Layer } from "effect";

import { ProjectExport } from "../Services/ProjectExport.ts";
import { notAvailableYet } from "./notAvailableYet.ts";

/** Stands in for the live export service; every call fails "not available yet". */
export const ProjectExportPlaceholder = Layer.succeed(
  ProjectExport,
  ProjectExport.of({
    inspect: () => Effect.fail(notAvailableYet()),
    start: () => Effect.fail(notAvailableYet()),
    readChunk: () => Effect.fail(notAvailableYet()),
    dispose: () => Effect.fail(notAvailableYet()),
    sweep: () => Effect.void,
  }),
);
