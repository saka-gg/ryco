/**
 * The method names of the cross-node project copy RPCs (`WsProjectCopyRpcGroup`
 * in `@ryco/contracts/project-copy-rpc`), which a node announces with
 * `capabilities.projectCopy`. They are kept apart from `WS_METHODS` and from the
 * RPC schemas: the app's boot carries `WS_METHODS` but never calls these, and
 * the access policies name them without loading the schemas.
 *
 * Exported as `@ryco/contracts/project-copy-methods`.
 *
 * @module projectCopyMethods
 */
export const PROJECT_COPY_WS_METHODS = {
  pathHints: "projects.pathHints",
  searchDirectories: "filesystem.searchDirectories",
  previewDestination: "projects.previewDestination",
  checkRemoteAccess: "projects.checkRemoteAccess",
  exportInspect: "projects.exportInspect",
  exportStart: "projects.exportStart",
  exportReadChunk: "projects.exportReadChunk",
  exportDispose: "projects.exportDispose",
  transferBegin: "projects.transferBegin",
  transferAppend: "projects.transferAppend",
  transferCommit: "projects.transferCommit",
  transferAbort: "projects.transferAbort",
  importStart: "projects.importStart",
  subscribeImport: "projects.subscribeImport",
  cancelImport: "projects.cancelImport",
  listImports: "projects.listImports",
  discardImport: "projects.discardImport",
} as const;
