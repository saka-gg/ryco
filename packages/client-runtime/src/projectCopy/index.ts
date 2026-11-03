// The cross-node project copy coordinator: planning a copy from the source's export and the
// user's options, running export → transfers → import against two nodes, and its progress
// model. Used by the copy and add-project dialogs and the Agent Control client executor.
export * from "./io.ts";
export * from "./jobRecord.ts";
export * from "./pipeline.ts";
export * from "./plan.ts";
export * from "./run.ts";
// The remote-URL rules the nodes enforce, so the client plans with the same ones.
export {
  classifyRemoteUrl,
  isCloneableRemoteKind,
  isRecreatableRemoteKind,
  repositoryFolderName,
  sanitizeRemoteUrl,
  type GitRemoteUrlKind as RemoteUrlKind,
} from "@ryco/shared/gitRemoteUrl";
