/**
 * The provider sign-in flows of this node, loaded by `ProviderSignIn` on its first call.
 *
 * One flow per instance. A flow runs in the layer's scope, so it outlives the client that
 * started it (a phone opening the browser) and ends with the server. It ends once its method
 * reports, fails, is cancelled or reaches its 15-minute deadline. A method's success is never
 * taken as proof: the instance's provider snapshot is refreshed and must report a sign-in, and the
 * instance must still resolve to the binary, store and environment the flow started with. An
 * ended flow stays visible for two minutes, then the instance shows idle again.
 *
 * Nothing is persisted and nothing a person types or reads (codes, URLs, output) is logged.
 *
 * @module providerSignInRuntime
 */
import * as NodePath from "node:path";

import {
  CodexSettings,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  ProviderSignInError,
  type ProviderSignInInteraction,
  type ProviderSignInMethod,
  type ProviderSignInPhase,
  type ProviderSignInState,
  type ServerProvider,
  type ServerSettings,
} from "@ryco/contracts";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  type FileSystem,
  Option,
  type Path,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { providerInstanceConfigFor, resolveInstanceEnabled } from "../providerInstanceConfig.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { prepareCodexDeviceCodeSignIn } from "./codexDeviceCodeSignIn.ts";
import type { ProviderSignInServices, ProviderSignInShape } from "./ProviderSignIn.ts";

/** A device code lives 15 minutes, and so does every flow. */
export const PROVIDER_SIGN_IN_DEADLINE = Duration.minutes(15);
/** How long an ended flow stays visible, so a phone returning from the browser sees it. */
export const PROVIDER_SIGN_IN_RETENTION = Duration.minutes(2);
const VERIFY_TIMEOUT = Duration.seconds(20);
const MAX_RUNNING_FLOWS = 3;

const ENDED_PHASES: ReadonlySet<ProviderSignInPhase> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
const isRunning = (phase: ProviderSignInPhase) => phase !== "idle" && !ENDED_PHASES.has(phase);

type MethodServices = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

/** A sign-in method resolved for one instance, ready to run. */
interface PreparedSignIn {
  readonly method: ProviderSignInMethod;
  /** Flows with one key write the same credentials; only one of them runs at a time. */
  readonly credentialKey: string;
  /** What the flow signs in: compared with `currentBinding` before success is reported. */
  readonly binding: string;
  readonly currentBinding: (
    settings: ServerSettings,
  ) => Effect.Effect<string | undefined, never, Path.Path>;
  readonly run: (hooks: {
    readonly waiting: (interaction: ProviderSignInInteraction) => Effect.Effect<void>;
  }) => Effect.Effect<{ readonly message: string | null }, ProviderSignInError, MethodServices>;
}

interface Flow {
  readonly flowId: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly method: ProviderSignInMethod;
  /** The instance's name in messages. */
  readonly name: string;
  readonly credentialKey: string;
  readonly startedAtMs: number;
  readonly cancel: Deferred.Deferred<void>;
  /** Completes once the flow ended and the process it ran is gone. */
  readonly ended: Deferred.Deferred<void>;
  readonly state: ProviderSignInState;
}

type Outcome =
  | { readonly phase: "succeeded"; readonly message: string | null }
  | { readonly phase: "failed"; readonly message: string }
  | { readonly phase: "expired" }
  | { readonly phase: "cancelled" };

const signInError = (message: string) => new ProviderSignInError({ message });
const NO_LONGER_ACTIVE = "This sign-in is no longer active.";

type Availability =
  | {
      readonly method: ProviderSignInMethod;
      readonly reason: null;
      readonly instance: ProviderInstanceConfig;
    }
  | { readonly method: null; readonly reason: string };

/**
 * Whether Start can run for the instance, from the settings alone: no process starts. Whether it
 * is enabled is decided as the registry decides it, from the config decoded with the driver's
 * schema, so a driver's default applies.
 */
export const signInAvailability = (
  settings: ServerSettings | undefined,
  instanceId: ProviderInstanceId,
): Availability => {
  const unavailable = (reason: string) => ({ method: null, reason });
  if (!settings) return unavailable("Provider settings could not be read on the node.");
  const instance = providerInstanceConfigFor(settings, instanceId);
  if (!instance) return unavailable("This provider instance is not configured on the node.");
  if (instance.driver === "acpRegistry") {
    return unavailable("Use ACP Registry authentication below.");
  }
  if (instance.driver !== "codex") {
    return unavailable(
      "Sign-in from Ryco is not available for this provider yet. Run its login on the node.",
    );
  }
  const codex = Schema.decodeUnknownOption(CodexSettings)(instance.config ?? {});
  if (Option.isNone(codex)) return unavailable("Fix this Codex instance's settings to sign in.");
  if (!resolveInstanceEnabled(instance, codex.value)) {
    return unavailable("Enable this provider instance to sign in.");
  }
  return { method: "codexDeviceCode", reason: null, instance };
};

const idleState = (
  instanceId: ProviderInstanceId,
  settings: ServerSettings | undefined,
): ProviderSignInState => {
  const { method, reason } = signInAvailability(settings, instanceId);
  return {
    instanceId,
    phase: "idle",
    flowId: null,
    method,
    unavailableReason: reason,
    interaction: null,
    expiresAt: null,
    message: null,
  };
};

const sameState = (left: ProviderSignInState, right: ProviderSignInState) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Claude reports "authenticated" whenever it starts; only an account shows a login took. */
const reportsSignIn = (provider: ServerProvider) =>
  provider.auth.status === "authenticated" &&
  (provider.driver !== "claudeAgent" ||
    provider.auth.email !== undefined ||
    provider.auth.label !== undefined);

export const makeProviderSignInRuntime: Effect.Effect<
  ProviderSignInShape,
  never,
  ProviderSignInServices
> = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const config = yield* ServerConfig;
  const scope = yield* Scope.Scope;
  const services = yield* Effect.context<MethodServices>();
  const flows = yield* SubscriptionRef.make<ReadonlyMap<ProviderInstanceId, Flow>>(new Map());
  const admission = yield* Semaphore.make(1);

  const readSettings = serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined));

  /** A private, per-instance working directory; the login never runs in a project. */
  const privateCwd = (instanceId: ProviderInstanceId) =>
    NodePath.join(config.stateDir, "provider-sign-in", Buffer.from(instanceId).toString("hex"));

  /** Applies `next` only while `flow` is still the instance's running flow. */
  const transition = (flow: Flow, next: Partial<ProviderSignInState>) =>
    SubscriptionRef.modify(flows, (current) => {
      const active = current.get(flow.instanceId);
      if (active?.flowId !== flow.flowId || !isRunning(active.state.phase)) {
        return [false, current] as const;
      }
      const updated = new Map(current);
      updated.set(flow.instanceId, { ...active, state: { ...active.state, ...next } });
      return [true, updated] as const;
    });

  const end = (flow: Flow, outcome: Outcome) =>
    Effect.gen(function* () {
      const message =
        outcome.phase === "cancelled"
          ? "Sign-in cancelled."
          : outcome.phase === "expired"
            ? "The sign-in expired. Start again."
            : outcome.message;
      const ended = yield* transition(flow, {
        phase: outcome.phase,
        interaction: null,
        expiresAt: null,
        // Within the contract's bound even for a very long instance name.
        message: message?.slice(0, 500) ?? null,
      });
      if (!ended) return;
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("provider sign-in finished", {
        instanceId: flow.instanceId,
        driver: flow.driver,
        method: flow.method,
        outcome: outcome.phase,
        durationMs: now - flow.startedAtMs,
      });
    });

  /** Refreshes the instance and checks that the login took, for the instance it started for. */
  const verify = (flow: Flow, prepared: PreparedSignIn, message: string | null) =>
    Effect.gen(function* () {
      yield* transition(flow, { phase: "verifying", interaction: null });
      const settings = yield* readSettings;
      const binding = settings === undefined ? undefined : yield* prepared.currentBinding(settings);
      if (binding !== prepared.binding) {
        return {
          phase: "failed",
          message: "Provider settings changed during sign-in. Start again.",
        } satisfies Outcome;
      }
      const read = providerRegistry
        .refreshInstance(flow.instanceId)
        .pipe(
          Effect.map((providers) =>
            providers.find((candidate) => candidate.instanceId === flow.instanceId),
          ),
        );
      // A refresh already running when the login ended joins that flight, whose probe can predate
      // the credentials, so an answer without a sign-in gets one more read within the same limit.
      const provider = Option.getOrUndefined(
        yield* read.pipe(
          Effect.flatMap((first) =>
            first !== undefined && reportsSignIn(first) ? Effect.succeed(first) : read,
          ),
          Effect.timeoutOption(VERIFY_TIMEOUT),
        ),
      );
      if (provider === undefined || !reportsSignIn(provider)) {
        return {
          phase: "failed",
          message: `The login finished, but ${flow.name} still reports no sign-in. Refresh providers.`,
        } satisfies Outcome;
      }
      const account = provider.auth.email ?? provider.auth.label;
      return {
        phase: "succeeded",
        message: message ?? (account ? `Signed in as ${account}.` : "Signed in."),
      } satisfies Outcome;
    });

  const runFlow = (flow: Flow, prepared: PreparedSignIn) =>
    Effect.gen(function* () {
      const result = yield* prepared
        .run({ waiting: (interaction) => transition(flow, { phase: "waiting", interaction }) })
        .pipe(
          Effect.map((success): Outcome => ({ phase: "succeeded", message: success.message })),
          Effect.catch((error) =>
            Effect.succeed<Outcome>({ phase: "failed", message: error.message }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed<Outcome>({
                  phase: "failed",
                  message: "The sign-in stopped unexpectedly. Try again.",
                }),
          ),
          Effect.timeoutOrElse({
            duration: PROVIDER_SIGN_IN_DEADLINE,
            orElse: () => Effect.succeed<Outcome>({ phase: "expired" }),
          }),
          // A cancel interrupts the method, which ends its process, before the race answers.
          (running) =>
            Effect.raceFirst(
              running,
              Deferred.await(flow.cancel).pipe(Effect.as<Outcome>({ phase: "cancelled" })),
            ),
        );
      const outcome =
        result.phase === "succeeded" ? yield* verify(flow, prepared, result.message) : result;
      yield* end(flow, outcome);
      yield* Deferred.succeed(flow.ended, undefined);
      yield* Effect.sleep(PROVIDER_SIGN_IN_RETENTION);
      yield* SubscriptionRef.update(flows, (current) => {
        if (current.get(flow.instanceId)?.flowId !== flow.flowId) return current;
        const updated = new Map(current);
        updated.delete(flow.instanceId);
        return updated;
      });
    }).pipe(
      Effect.provideContext(services),
      Effect.ensuring(Deferred.succeed(flow.ended, undefined)),
    );

  const start = (instanceId: ProviderInstanceId) =>
    admission.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(flows);
        const existing = current.get(instanceId);
        if (existing !== undefined && isRunning(existing.state.phase)) return existing.state;

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(() => signInError("Provider settings could not be read on the node.")),
        );
        const availability = signInAvailability(settings, instanceId);
        if (availability.method === null) return yield* signInError(availability.reason);
        const { instance } = availability;
        const prepared: PreparedSignIn = yield* prepareCodexDeviceCodeSignIn(
          settings,
          instanceId,
          privateCwd(instanceId),
        ).pipe(Effect.provideContext(services));

        const running = [...current.values()].filter((flow) => isRunning(flow.state.phase));
        if (running.some((flow) => flow.credentialKey === prepared.credentialKey)) {
          return yield* signInError("Another sign-in for this account store is running.");
        }
        if (running.length >= MAX_RUNNING_FLOWS) {
          return yield* signInError(
            "Three sign-ins are already running on this node. Finish one first.",
          );
        }

        const startedAtMs = yield* Clock.currentTimeMillis;
        const flowId = crypto.randomUUID();
        const flow: Flow = {
          flowId,
          instanceId,
          driver: instance.driver,
          method: prepared.method,
          name:
            instance.displayName?.trim() || PROVIDER_DISPLAY_NAMES[instance.driver] || instanceId,
          credentialKey: prepared.credentialKey,
          startedAtMs,
          cancel: yield* Deferred.make<void>(),
          ended: yield* Deferred.make<void>(),
          state: {
            instanceId,
            phase: "starting",
            flowId,
            method: prepared.method,
            unavailableReason: null,
            interaction: null,
            expiresAt: new Date(
              startedAtMs + Duration.toMillis(PROVIDER_SIGN_IN_DEADLINE),
            ).toISOString(),
            message: null,
          },
        };
        yield* SubscriptionRef.update(flows, (all) => new Map(all).set(instanceId, flow));
        yield* runFlow(flow, prepared).pipe(Effect.forkIn(scope));
        return flow.state;
      }),
    );

  const respond: ProviderSignInShape["respond"] = (input) =>
    Effect.gen(function* () {
      const flow = (yield* SubscriptionRef.get(flows)).get(input.instanceId);
      if (flow === undefined || flow.flowId !== input.flowId || !isRunning(flow.state.phase)) {
        return yield* signInError(NO_LONGER_ACTIVE);
      }
      switch (input.action.type) {
        case "cancel": {
          if (flow.state.phase === "verifying") {
            return yield* signInError(
              "The sign-in is being checked and can no longer be cancelled.",
            );
          }
          yield* Deferred.succeed(flow.cancel, undefined);
          yield* Deferred.await(flow.ended);
          return;
        }
        case "input":
        case "resize":
          return yield* signInError("This sign-in does not take terminal input.");
      }
    });

  /** Every state of the instance's flows; while none runs, what the settings make available. */
  const subscribe: ProviderSignInShape["subscribe"] = (instanceId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Folded in one ordered step, so no state of a flow is skipped.
        let latest: {
          readonly flow?: Flow | undefined;
          readonly settings?: ServerSettings | undefined;
        } = {
          settings: yield* readSettings,
        };
        return Stream.merge(
          SubscriptionRef.changes(flows).pipe(
            Stream.map((current) => ({ flow: current.get(instanceId) })),
          ),
          serverSettings.streamChanges.pipe(Stream.map((settings) => ({ settings }))),
        ).pipe(
          Stream.map((change) => {
            latest = { ...latest, ...change };
            return latest.flow?.state ?? idleState(instanceId, latest.settings);
          }),
          Stream.changesWith(sameState),
          Stream.map((state) => ({ type: "state" as const, state })),
        );
      }),
    );

  return { subscribe, start, respond } satisfies ProviderSignInShape;
});
