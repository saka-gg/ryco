import { Effect, Layer } from "effect";

import { ProjectSetupCommandError } from "../Errors.ts";
import { ProjectSetupCommand } from "../Services/ProjectSetupCommand.ts";
import { NOT_AVAILABLE_YET } from "./notAvailableYet.ts";

/** Stands in for the live setup command runner; it never starts a command. */
export const ProjectSetupCommandPlaceholder = Layer.succeed(
  ProjectSetupCommand,
  ProjectSetupCommand.of({
    run: () =>
      Effect.fail(new ProjectSetupCommandError({ reason: "internal", message: NOT_AVAILABLE_YET })),
  }),
);
