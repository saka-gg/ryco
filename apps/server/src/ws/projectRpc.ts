import { Effect, Option, Schema } from "effect";
import {
  FilesystemBrowseError,
  ProjectListEntriesError,
  ProjectReadIconError,
  ProjectReadFileBinaryError,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  ProjectStageFileReferenceError,
  ProjectWriteFileError,
  WS_METHODS,
} from "@ryco/contracts";

import { readProjectIcon } from "../project/readProjectIcon.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import {
  WorkspaceFileConflictError,
  WorkspaceFileDeletedError,
  WorkspaceFileSystemError,
  WorkspaceFileUnsupportedEditError,
} from "../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export const makeProjectHandlers = (ctx: WsRpcContext) => {
  const { ownerEffect, workspaceEntries, workspaceFileSystem, open } = ctx;

  return defineWsHandlers({
    [WS_METHODS.projectsReadIcon]: (input) =>
      ctx.withAccess(
        "viewer",
        WS_METHODS.projectsReadIcon,
        Effect.gen(function* () {
          const project = yield* ctx.projectionSnapshotQuery
            .getProjectShellById(input.projectId)
            .pipe(
              Effect.mapError(
                () => new ProjectReadIconError({ message: "Could not load project artwork." }),
              ),
            );
          if (Option.isNone(project)) return null;
          return yield* readProjectIcon(project.value, {
            favicon: Option.getOrNull(ctx.projectFaviconResolver),
            avatar: Option.getOrNull(ctx.projectAvatarStore),
          });
        }),
      ),
    [WS_METHODS.projectsSearchEntries]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsSearchEntries,
        ownerEffect(
          WS_METHODS.projectsSearchEntries,
          workspaceEntries.search(input).pipe(
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
    [WS_METHODS.projectsListEntries]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsListEntries,
        ownerEffect(
          WS_METHODS.projectsListEntries,
          workspaceEntries.listEntries(input).pipe(
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
          workspaceFileSystem.readFile(input).pipe(
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
          workspaceFileSystem.readFileBinary(input).pipe(
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
        ownerEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input)),
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
