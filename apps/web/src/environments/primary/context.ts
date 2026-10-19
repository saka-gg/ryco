import { createPrimaryEnvironmentContext } from "@ryco/client-runtime/connection";
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import { webEndpoint } from "../../platform/endpoint";
import { webHttpClient } from "../../platform/httpClient";
import { BootstrapHttpError, retryTransientBootstrap } from "./auth";

const context = createPrimaryEnvironmentContext({
  endpoint: webEndpoint,
  httpClient: webHttpClient,
  retryTransientBootstrap,
  createBootstrapHttpError: (input) => new BootstrapHttpError(input),
});

export const readPrimaryEnvironmentDescriptor = context.readPrimaryEnvironmentDescriptor;
export const subscribePrimaryEnvironmentDescriptor = context.store.subscribe;
export const writePrimaryEnvironmentDescriptor = context.writePrimaryEnvironmentDescriptor;
export const getPrimaryKnownEnvironment = context.getPrimaryKnownEnvironment;
export const resolveInitialPrimaryEnvironmentDescriptor =
  context.resolveInitialPrimaryEnvironmentDescriptor;
export const __resetPrimaryEnvironmentBootstrapForTests = context.resetForTests;
export const resetPrimaryEnvironmentDescriptorForTests = context.resetForTests;
export const __resetPrimaryEnvironmentDescriptorBootstrapForTests = context.resetForTests;

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useSyncExternalStore(
    context.store.subscribe,
    () => context.store.getState().descriptor?.environmentId ?? null,
    () => null,
  );
}

export function usePrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  return useSyncExternalStore(
    context.store.subscribe,
    () => context.store.getState().descriptor,
    () => null,
  );
}

export type { ExecutionEnvironmentDescriptor };
