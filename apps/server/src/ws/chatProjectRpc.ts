import { Effect, Option } from "effect";
import { ProjectChatError, WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { deleteChatFolder } from "../project/chatFolders.ts";
import { type ChatPromotionShape, makeChatPromotion } from "../project/chatPromotion.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

/**
 * Chat-folder RPCs: "Turn into project…" (preview and promotion) and "Also delete files". A node
 * without chat support refuses all of them with `chats-unavailable` and touches nothing.
 */
export const makeChatProjectHandlers = (ctx: WsRpcContext) => {
  const { ownerEffect } = ctx;
  const unavailable = () =>
    new ProjectChatError({
      reason: "chats-unavailable",
      message: "This server cannot manage chat folders yet.",
    });

  const promotion: Option.Option<ChatPromotionShape> = (() => {
    const { projectionProjects, projectionThreads, chatFolders, providerService } = ctx;
    const { projectRelocations, storageAdmission } = ctx;
    if (
      Option.isNone(projectionProjects) ||
      Option.isNone(projectionThreads) ||
      Option.isNone(chatFolders) ||
      Option.isNone(providerService) ||
      Option.isNone(projectRelocations) ||
      Option.isNone(storageAdmission)
    ) {
      return Option.none();
    }
    return Option.some(
      makeChatPromotion({
        projects: projectionProjects.value,
        threads: projectionThreads.value,
        snapshots: ctx.projectionSnapshotQuery,
        relocations: projectRelocations.value,
        chatFolders: chatFolders.value,
        policy: ctx.workspaceAccessPolicy,
        config: ctx.config,
        settings: ctx.serverSettings,
        providers: providerService.value,
        terminals: ctx.terminalManager,
        // Server-internal: the client normalizer refuses a chat's kind and root changes.
        dispatch: ctx.dispatchNormalizedCommand,
        initializeGit: (projectId, options) => ctx.initializeGitForProject(projectId, options),
        storageAdmission: storageAdmission.value,
        git: ctx.gitDriver,
      }),
    );
  })();

  const withPromotion = <A>(
    use: (promotion: ChatPromotionShape) => Effect.Effect<A, ProjectChatError>,
  ): Effect.Effect<A, ProjectChatError> =>
    Option.match(promotion, {
      onNone: () => Effect.fail(unavailable()),
      onSome: use,
    });

  return defineWsHandlers({
    [WS_METHODS.projectsPromoteChatPreview]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsPromoteChatPreview,
        ownerEffect(
          WS_METHODS.projectsPromoteChatPreview,
          withPromotion((promotion) => promotion.preview(input)),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsPromoteChat]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsPromoteChat,
        ownerEffect(
          WS_METHODS.projectsPromoteChat,
          withPromotion((promotion) => promotion.promote(input)),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsDeleteChatFolder]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsDeleteChatFolder,
        ownerEffect(
          WS_METHODS.projectsDeleteChatFolder,
          Effect.gen(function* () {
            const { projectionProjects, projectionThreads, chatFolders, providerService } = ctx;
            if (
              Option.isNone(projectionProjects) ||
              Option.isNone(projectionThreads) ||
              Option.isNone(chatFolders) ||
              Option.isNone(providerService)
            ) {
              return yield* unavailable();
            }
            return yield* deleteChatFolder(
              {
                projects: projectionProjects.value,
                threads: projectionThreads.value,
                chatFolders: chatFolders.value,
                workspaces: ctx.projectionSnapshotQuery,
                settleThreadCleanup: ctx.settleThreadDeletionCleanup,
                listSessions: providerService.value.listSessions,
              },
              input.projectId,
            );
          }),
        ),
        { "rpc.aggregate": "workspace" },
      ),
  });
};
