import { Effect, Option, Schema } from "effect";
import {
  FilesystemBrowseError,
  ProjectListEntriesError,
  type ProjectListEntriesResult,
  ProjectReadIconError,
  ProjectReadFileBinaryError,
  ProjectReadFileError,
  ProjectSearchContentError,
  ProjectSearchEntriesError,
  ProjectStageFileReferenceError,
  ProjectWriteFileError,
  WS_METHODS,
} from "@ryco/contracts";

import { readProjectIcon } from "../project/readProjectIcon.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { WorkspaceContentSearchCursorError } from "../workspace/Services/WorkspaceContentSearch.ts";
import {
  WorkspaceFileConflictError,
  WorkspaceFileDeletedError,
  WorkspaceFileSystemError,
  WorkspaceFileUnsupportedEditError,
} from "../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export const makeProjectHandlers = (ctx: WsRpcContext) => {
  const { ownerEffect, workspaceEntries, workspaceContentSearch, workspaceFileSystem, open } = ctx;
  /**
   * A chat folder empty-folder cleanup removed lists as empty: looking at an old chat's files
   * does not bring its folder back (`project/chatFolderRestore.ts`). Checked only on failure.
   */
  const emptyListing: ProjectListEntriesResult = { entries: [], truncated: false };
  const emptyForRemovedChatFolder = <A, E, B>(
    cwd: string,
    listing: Effect.Effect<A, E>,
    empty: B,
  ): Effect.Effect<A | B, E> =>
    listing.pipe(
      Effect.catch((cause) =>
        Option.match(ctx.removedChatFolders, {
          onNone: () => Effect.fail(cause),
          onSome: ({ isRemoved }) =>
            isRemoved(cwd).pipe(
              Effect.flatMap((removed) => (removed ? Effect.succeed(empty) : Effect.fail(cause))),
            ),
        }),
      ),
    );

  return defineWsHandlers({
    [WS_METHODS.projectsReadIcon]: (input) =>
      ctx.withAccess(
        "viewer",
        WS_METHODS.projectsReadIcon,
        Effect.gen(function* () {
          if (Option.isNone(ctx.projectionProjects)) return null;
          const project = yield* ctx.projectionProjects.value
            .getById(input)
            .pipe(
              Effect.mapError(
                () => new ProjectReadIconError({ message: "Could not load project artwork." }),
              ),
            );
          if (Option.isNone(project) || project.value.deletedAt !== null) return null;
          return yield* readProjectIcon(
            { ...project.value, id: project.value.projectId },
            {
              favicon: Option.getOrNull(ctx.projectFaviconResolver),
              avatar: Option.getOrNull(ctx.projectAvatarStore),
            },
          );
        }),
      ),
    [WS_METHODS.projectsSearchEntries]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsSearchEntries,
        ownerEffect(
          WS_METHODS.projectsSearchEntries,
          emptyForRemovedChatFolder(input.cwd, workspaceEntries.search(input), emptyListing).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchEntriesError({
                  message: `Failed to search workspace entries: ${cause.detail}`,
                  cause,
                }),
            ),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    // The query never reaches logs or span attributes: it may be anything the user typed.
    [WS_METHODS.projectsSearchContent]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsSearchContent,
        ownerEffect(
          WS_METHODS.projectsSearchContent,
          emptyForRemovedChatFolder(input.cwd, workspaceContentSearch.search(input), {
            matches: [],
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(WorkspaceContentSearchCursorError)(cause)
                ? new ProjectSearchContentError({ message: cause.message, reason: "cursor" })
                : new ProjectSearchContentError({
                    message: `Failed to search workspace contents: ${cause.detail}`,
                    reason: "failed",
                    cause,
                  }),
            ),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsListEntries]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsListEntries,
        ownerEffect(
          WS_METHODS.projectsListEntries,
          emptyForRemovedChatFolder(
            input.cwd,
            workspaceEntries.listEntries(input),
            emptyListing,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectListEntriesError({
                  message: `Failed to list workspace entries: ${cause.detail}`,
                  cause,
                }),
            ),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsReadFile]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsReadFile,
        ownerEffect(
          WS_METHODS.projectsReadFile,
          ctx.clientWorkspaceUse.use(input.cwd, workspaceFileSystem.readFile(input)).pipe(
            Effect.mapError((cause) => {
              const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                ? "Workspace file path must stay within the project root."
                : cause.detail;
              return new ProjectReadFileError({
                message,
                cause,
              });
            }),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsReadFileBinary]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsReadFileBinary,
        ownerEffect(
          WS_METHODS.projectsReadFileBinary,
          ctx.clientWorkspaceUse.use(input.cwd, workspaceFileSystem.readFileBinary(input)).pipe(
            Effect.mapError((cause) => {
              const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                ? "Workspace file path must stay within the project root."
                : cause.detail;
              return new ProjectReadFileBinaryError({
                message,
                cause,
              });
            }),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsWriteFile]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsWriteFile,
        ownerEffect(
          WS_METHODS.projectsWriteFile,
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError((cause) => {
              const conflict = Schema.is(WorkspaceFileConflictError)(cause);
              const deleted = Schema.is(WorkspaceFileDeletedError)(cause);
              const unsupported = Schema.is(WorkspaceFileUnsupportedEditError)(cause);
              const outside = Schema.is(WorkspacePathOutsideRootError)(cause);
              const reason = conflict
                ? "conflict"
                : deleted
                  ? "deleted"
                  : unsupported
                    ? "unsupported"
                    : "failed";
              const message = outside
                ? "Workspace file path must stay within the project root."
                : conflict || deleted || unsupported
                  ? cause.message
                  : Schema.is(WorkspaceFileSystemError)(cause)
                    ? cause.detail
                    : "Failed to write workspace file.";
              return new ProjectWriteFileError({
                message,
                reason,
                cause,
              });
            }),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsStageFileReference]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsStageFileReference,
        ownerEffect(
          WS_METHODS.projectsStageFileReference,
          workspaceFileSystem.stageFileReference(input).pipe(
            Effect.mapError((cause) => {
              const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                ? "Workspace file path must stay within the project root."
                : cause.detail;
              return new ProjectStageFileReferenceError({
                message,
                cause,
              });
            }),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.shellOpenInEditor]: (input) =>
      observeRpcEffect(
        WS_METHODS.shellOpenInEditor,
        ownerEffect(
          WS_METHODS.shellOpenInEditor,
          ctx.clientWorkspaceUse.externalEditor(input.cwd, open.openInEditor(input)),
        ),
        {
          "rpc.aggregate": "workspace",
        },
      ),
    [WS_METHODS.filesystemBrowse]: (input) =>
      observeRpcEffect(
        WS_METHODS.filesystemBrowse,
        ownerEffect(
          WS_METHODS.filesystemBrowse,
          workspaceEntries.browse(input).pipe(
            Effect.mapError(
              (cause) =>
                new FilesystemBrowseError({
                  message: cause.detail,
                  cause,
                }),
            ),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
  });
};
