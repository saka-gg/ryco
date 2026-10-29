/**
 * ProviderSignIn - Signs a provider instance in from any owner client: one flow per instance,
 * run on this node with the instance's own binary, homes and environment, followed by every
 * owner session and outliving the client that started it.
 *
 * The service is the flows' runtime (`providerSignInRuntime.ts`), loaded and built on first use,
 * so the boot path carries only this module.
 *
 * @module ProviderSignIn
 */
import type {
  ProviderInstanceId,
  ProviderSignInError,
  ProviderSignInEvent,
  ProviderSignInRespondInput,
  ProviderSignInState,
} from "@ryco/contracts";
import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  type Scope,
  type Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";

import type { ServerConfig } from "../../config.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderRegistry } from "../Services/ProviderRegistry.ts";

export interface ProviderSignInShape {
  /** The instance's current state, then every change; never fails for an unknown instance. */
  readonly subscribe: (
    instanceId: ProviderInstanceId,
  ) => Stream.Stream<ProviderSignInEvent, ProviderSignInError>;
  /** Starts a flow, or answers the state of the one already running for the instance. */
  readonly start: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderSignInState, ProviderSignInError>;
  readonly respond: (input: ProviderSignInRespondInput) => Effect.Effect<void, ProviderSignInError>;
}

/** Yields the runtime, building it on the first call. */
export class ProviderSignIn extends Context.Service<
  ProviderSignIn,
  Effect.Effect<ProviderSignInShape>
>()("ryco/provider/signIn/ProviderSignIn") {}

/** What the runtime runs flows with; they run in this layer's scope and end with it. */
export type ProviderSignInServices =
  | ServerSettingsService
  | ProviderRegistry
  | ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;

export const ProviderSignInLive = Layer.effect(
  ProviderSignIn,
  Effect.flatMap(Effect.context<ProviderSignInServices>(), (context) =>
    Effect.cached(
      Effect.promise(() => import("./providerSignInRuntime.ts")).pipe(
        Effect.flatMap((module) => module.makeProviderSignInRuntime),
        Effect.provideContext(context),
      ),
    ),
  ),
);
