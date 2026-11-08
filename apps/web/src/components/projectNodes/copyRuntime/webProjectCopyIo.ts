// FILE: webProjectCopyIo.ts
// Purpose: The web client's `ProjectCopyIo` for the copy coordinator: the
//          shared node IO (`@ryco/client-runtime/projectCopy/nodeIo`) bound to
//          this client's `acquireNode`, its environment APIs, the config each
//          connection reports, and its connection registry.
// Layer: Web copy runtime, loaded on demand (never from the app shell). The
//        copy dialog, the add-project dialog's copy source and the Agent
//        Control executor all run copies through `copyManager`, which creates
//        one IO per copy.

import {
  callNodeToRead as callSharedNodeToRead,
  callNodeWithLease as callSharedNodeWithLease,
  createProjectCopyNodeIo,
  type ProjectCopyNodeAcquire,
  type ProjectCopyNodeIo,
  type ProjectCopyNodeIoDeps,
} from "@ryco/client-runtime/projectCopy/nodeIo";
import type { EnvironmentApi, EnvironmentId } from "@ryco/contracts";

import { readEnvironmentApi } from "../../../environmentApi";
import { acquireNode } from "../../../environments/acquireNode";
import { readNodeServerConfig } from "../../../environments/nodeServerConfig";
import { subscribeEnvironmentConnections } from "../../../environments/runtime";
import { randomUUID } from "../../../lib/utils";

export type WebProjectCopyAcquire = ProjectCopyNodeAcquire;
export type WebProjectCopyIo = ProjectCopyNodeIo;

const webAcquire: ProjectCopyNodeAcquire = (environmentId, options) =>
  acquireNode(environmentId, options);

/** One copy's IO; tests override how nodes are acquired and watched. */
export function createWebProjectCopyIo(
  overrides: Partial<ProjectCopyNodeIoDeps> = {},
): WebProjectCopyIo {
  return createProjectCopyNodeIo({
    acquire: webAcquire,
    readApi: readEnvironmentApi,
    readCachedConfig: readNodeServerConfig,
    subscribeConnections: subscribeEnvironmentConnections,
    uuid: randomUUID,
    ...overrides,
  });
}

/** Reads from a node outside a copy's holds (see `callNodeToRead` in the shared IO). */
export function callNodeToRead<T>(
  environmentId: EnvironmentId,
  call: (api: EnvironmentApi) => Promise<T>,
  options: {
    readonly copyId: string;
    readonly signal?: AbortSignal;
    readonly acquire?: WebProjectCopyAcquire;
  },
): Promise<T> {
  return callSharedNodeToRead(environmentId, call, {
    ...options,
    acquire: options.acquire ?? webAcquire,
  });
}

/** Writes to a node outside a copy's holds (see `callNodeWithLease` in the shared IO). */
export function callNodeWithLease<T>(
  environmentId: EnvironmentId,
  call: (api: EnvironmentApi) => Promise<T>,
  options: {
    readonly copyId: string;
    readonly signal?: AbortSignal;
    readonly attempts?: number;
    readonly acquire?: WebProjectCopyAcquire;
  },
): Promise<T> {
  return callSharedNodeWithLease(environmentId, call, {
    ...options,
    acquire: options.acquire ?? webAcquire,
  });
}
