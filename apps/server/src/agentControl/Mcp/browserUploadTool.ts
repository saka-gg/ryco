import type { ComputerUseRequest, ThreadId } from "@ryco/contracts";
import { Effect, Option, Result } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  BROWSER_UPLOAD_BUSY,
  BROWSER_UPLOAD_REFUSED,
  BrowserUploadRefused,
  type BrowserUploadBudget,
  stageBrowserUpload,
} from "./browserUploadStaging.ts";
import type { AgentControlMcpToolResult } from "./tools.ts";

export { makeUploadBudget } from "./browserUploadStaging.ts";

/** No upload directory from the desktop: an older desktop, or it could not create one (its log says why). */
export const BROWSER_UPLOAD_UNAVAILABLE =
  "Browser upload is unavailable in this desktop session. Restarting or updating Ryco Desktop may fix it.";

const textResult = (text: string): AgentControlMcpToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

/**
 * The desktop's own argument checks that need no page, run before any file is copied: a request
 * the desktop would refuse at once costs no copy. Same messages as the desktop's.
 */
function uploadArgsRefusal(args: Readonly<Record<string, unknown>>): string | undefined {
  const { tab, ref } = args;
  if (typeof tab !== "string" || tab.length === 0 || tab.length > 512) return "Invalid tab.";
  if (ref !== undefined && (typeof ref !== "string" || ref.length === 0 || ref.length > 16))
    return "Invalid ref.";
  return undefined;
}

/**
 * A `ryco_browser` upload: the server copies the thread's workspace files into the desktop's private
 * upload directory, then hands the desktop the copies' paths; the desktop only ever gives Chromium
 * paths inside that directory. Refusals are results, so the caller's generic bridge message does
 * not replace them. `computerTools.ts` loads this module with the first upload, which keeps the
 * staging code off the server's boot path.
 */
export function uploadToRycoBrowser<E>(input: {
  readonly request: ComputerUseRequest;
  /** The calling session's thread, whose workspace the files come from. */
  readonly threadId: ThreadId;
  readonly uploadDir: string | undefined;
  readonly projections:
    | Pick<ProjectionSnapshotQueryShape, "getThreadCheckpointContext">
    | undefined;
  readonly workspaceAccess: Pick<WorkspaceAccessPolicyShape, "assertExistingPath"> | undefined;
  readonly budget: BrowserUploadBudget;
  readonly dispatch: (request: ComputerUseRequest) => Effect.Effect<AgentControlMcpToolResult, E>;
}): Effect.Effect<AgentControlMcpToolResult, E> {
  const { request, threadId, uploadDir, projections, workspaceAccess, budget, dispatch } = input;
  return Effect.gen(function* () {
    // Paired external browsers cannot upload (the desktop refuses them too): copy nothing.
    if (request.args.browser !== "ryco")
      return textResult('upload is available only for browser "ryco".');
    const invalid = uploadArgsRefusal(request.args);
    if (invalid) return textResult(invalid);
    if (!uploadDir || !projections || !workspaceAccess)
      return textResult(BROWSER_UPLOAD_UNAVAILABLE);
    const workspace = yield* Effect.gen(function* () {
      const context = Option.getOrUndefined(
        yield* projections.getThreadCheckpointContext(threadId),
      );
      const cwd = context?.worktreePath ?? context?.workspaceRoot;
      if (!cwd) return undefined;
      return yield* workspaceAccess.assertExistingPath({
        path: cwd,
        operation: "browser upload",
      });
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (!workspace) return textResult(BROWSER_UPLOAD_REFUSED);
    // Reserved and released as one resource, so an interruption at any point frees the bytes.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => budget.reserve()),
      (reservation) =>
        !reservation
          ? Effect.succeed(textResult(BROWSER_UPLOAD_BUSY))
          : Effect.gen(function* () {
              const staged = yield* Effect.tryPromise({
                try: (signal) =>
                  stageBrowserUpload({
                    uploadDir,
                    cwd: workspace,
                    paths: request.args.paths,
                    signal,
                    maxBytes: reservation.maxBytes,
                    limitBytes: reservation.limitBytes,
                  }),
                catch: (error) =>
                  error instanceof BrowserUploadRefused
                    ? error
                    : new BrowserUploadRefused({ reason: BROWSER_UPLOAD_REFUSED }),
              }).pipe(Effect.result);
              if (Result.isFailure(staged)) return textResult(staged.failure.reason);
              reservation.shrink(staged.success.bytes);
              // From the request on, the desktop owns the copies: it keeps them for the page,
              // or removes them when the request ends (or sweeps them if it never arrives).
              const { paths: _paths, ...rest } = request.args;
              return yield* dispatch({
                ...request,
                args: {
                  ...rest,
                  files: staged.success.files.map((file) => file.path),
                  uploadId: staged.success.uploadId,
                },
              });
            }),
      (reservation) => Effect.sync(() => reservation?.release()),
    );
  });
}
