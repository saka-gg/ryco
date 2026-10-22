import { Effect, Layer } from "effect";

import { ProjectImportStepError } from "../Errors.ts";
import { ProjectImportGit } from "../Services/ProjectImportGit.ts";
import { NOT_AVAILABLE_YET } from "./notAvailableYet.ts";

const stepFailure = () =>
  Effect.fail(
    new ProjectImportStepError({ code: "internal", message: NOT_AVAILABLE_YET, detail: null }),
  );

/** Stands in for the live import git steps; every step fails "not available yet". */
export const ProjectImportGitPlaceholder = Layer.succeed(
  ProjectImportGit,
  ProjectImportGit.of({
    cloneNoCheckout: stepFailure,
    initFromBundle: stepFailure,
    fetchCommitsBundle: stepFailure,
    checkout: stepFailure,
    setRemotes: stepFailure,
    applyChanges: stepFailure,
    updateSubmodules: stepFailure,
    lfsPull: stepFailure,
  }),
);
