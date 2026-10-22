import { Effect, Layer } from "effect";

import { ProjectTransfers } from "../Services/ProjectTransfers.ts";
import { notAvailableYet } from "./notAvailableYet.ts";

/** Stands in for the live transfer service; every call fails "not available yet". */
export const ProjectTransfersPlaceholder = Layer.succeed(
  ProjectTransfers,
  ProjectTransfers.of({
    begin: () => Effect.fail(notAvailableYet()),
    append: () => Effect.fail(notAvailableYet()),
    commit: () => Effect.fail(notAvailableYet()),
    abort: () => Effect.fail(notAvailableYet()),
    claimForImport: () => Effect.fail(notAvailableYet()),
    releaseImport: () => Effect.void,
    sweep: () => Effect.void,
  }),
);
