import { Effect, Layer } from "effect";

import { AgentControlNodeDirectoryError } from "../Errors.ts";
import { AgentControlNodeDirectory } from "../Services/AgentControlNodeDirectory.ts";

const unavailable = () =>
  Effect.fail(
    new AgentControlNodeDirectoryError({ reason: "unavailable", detail: "not available yet" }),
  );

/**
 * Stands in for the live node directory until it replaces this layer: publishing and reading
 * both fail "not available yet". The node does not advertise `capabilities.projectCopy`
 * meanwhile, so clients never publish.
 */
export const AgentControlNodeDirectoryPlaceholder = Layer.succeed(
  AgentControlNodeDirectory,
  AgentControlNodeDirectory.of({ publish: unavailable, list: unavailable }),
);
