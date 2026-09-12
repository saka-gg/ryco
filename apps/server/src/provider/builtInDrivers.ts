/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * Every driver that the server knows how to instantiate from settings is
 * listed here. The `ProviderInstanceRegistry` iterates this array when
 * resolving `providerInstances` entries; anything not in the array surfaces
 * as an `"unavailable"` shadow snapshot at runtime (see
 * `buildUnavailableProviderSnapshot`).
 *
 * Adding a new first-party driver means:
 *   1. implement `ProviderDriver` in a sibling `Drivers/<Name>Driver.ts`,
 *   2. add a lightweight lazy wrapper to this array,
 *   3. ensure the runtime layer satisfies its declared `R`.
 *
 * The aggregated `BuiltInDriversEnv` type is the union of every driver's
 * env requirement — the registry layer's `R` is this type, and the runtime
 * layer (ChildProcessSpawner, FileSystem, Path, ServerConfig,
 * OpenCodeRuntime, …) must satisfy it.
 *
 * @module provider/builtInDrivers
 */
import {
  AcpRegistrySettings,
  ClaudeSettings,
  CodexSettings,
  CopilotSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
  ProviderDriverKind,
} from "@ryco/contracts";
import { Effect, Schema } from "effect";

import type { AcpRegistryDriverEnv } from "./Drivers/AcpRegistryDriver.ts";
import type { ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import type { CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import type { CopilotDriverEnv } from "./Drivers/CopilotDriver.ts";
import type { CursorDriverEnv } from "./Drivers/CursorDriver.ts";
import type { GrokDriverEnv } from "./Drivers/GrokDriver.ts";
import type { OpenCodeDriverEnv } from "./Drivers/OpenCodeDriver.ts";
import { ProviderDriverError } from "./Errors.ts";
import type {
  AnyProviderDriver,
  ProviderDriver,
  ProviderDriverCreateInput,
} from "./ProviderDriver.ts";
import { agentControlSupportForDriver } from "../agentControl/ProviderInjection.ts";

/**
 * Union of infrastructure services required to construct any built-in
 * driver. The registry layer declares `R = BuiltInDriversEnv`; the runtime
 * layer must provide every service in this union.
 */
export type BuiltInDriversEnv =
  | AcpRegistryDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | CopilotDriverEnv
  | CursorDriverEnv
  | GrokDriverEnv
  | OpenCodeDriverEnv;

const codexDriverKind = ProviderDriverKind.make("codex");
const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
const copilotDriverKind = ProviderDriverKind.make("copilot");
const cursorDriverKind = ProviderDriverKind.make("cursor");
const grokDriverKind = ProviderDriverKind.make("grok");
const openCodeDriverKind = ProviderDriverKind.make("opencode");

const driverImportError = (
  driver: ProviderDriverKind,
  input: ProviderDriverCreateInput<unknown>,
  cause: unknown,
) =>
  new ProviderDriverError({
    driver,
    instanceId: input.instanceId,
    detail: `Failed to load ${driver} driver implementation.`,
    cause,
  });

const CodexLazyDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: codexDriverKind,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
    agentControl: agentControlSupportForDriver(codexDriverKind),
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => Schema.decodeSync(CodexSettings)({}),
  create: (input) =>
    Effect.tryPromise({
      try: () => import("./Drivers/CodexDriver.ts"),
      catch: (cause) => driverImportError(codexDriverKind, input, cause),
    }).pipe(Effect.flatMap(({ CodexDriver }) => CodexDriver.create(input))),
};

const ClaudeLazyDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: claudeDriverKind,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
    agentControl: agentControlSupportForDriver(claudeDriverKind),
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => Schema.decodeSync(ClaudeSettings)({}),
  create: (input) =>
    Effect.tryPromise({
      try: () => import("./Drivers/ClaudeDriver.ts"),
      catch: (cause) => driverImportError(claudeDriverKind, input, cause),
    }).pipe(Effect.flatMap(({ ClaudeDriver }) => ClaudeDriver.create(input))),
};

const CopilotLazyDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: copilotDriverKind,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
    agentControl: agentControlSupportForDriver(copilotDriverKind),
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => Schema.decodeSync(CopilotSettings)({}),
  create: (input) =>
    Effect.tryPromise({
      try: () => import("./Drivers/CopilotDriver.ts"),
      catch: (cause) => driverImportError(copilotDriverKind, input, cause),
    }).pipe(Effect.flatMap(({ CopilotDriver }) => CopilotDriver.create(input))),
};

const CursorLazyDriver: ProviderDriver<CursorSettings, CursorDriverEnv> = {
  driverKind: cursorDriverKind,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
    agentControl: agentControlSupportForDriver(cursorDriverKind),
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => Schema.decodeSync(CursorSettings)({}),
  create: (input) =>
    Effect.tryPromise({
      try: () => import("./Drivers/CursorDriver.ts"),
      catch: (cause) => driverImportError(cursorDriverKind, input, cause),
    }).pipe(Effect.flatMap(({ CursorDriver }) => CursorDriver.create(input))),
};

const GrokLazyDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  driverKind: grokDriverKind,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
    agentControl: agentControlSupportForDriver(grokDriverKind),
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => Schema.decodeSync(GrokSettings)({}),
  create: (input) =>
    Effect.tryPromise({
      try: () => import("./Drivers/GrokDriver.ts"),
      catch: (cause) => driverImportError(grokDriverKind, input, cause),
    }).pipe(Effect.flatMap(({ GrokDriver }) => GrokDriver.create(input))),
};

const OpenCodeLazyDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: openCodeDriverKind,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
    agentControl: agentControlSupportForDriver(openCodeDriverKind),
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => Schema.decodeSync(OpenCodeSettings)({}),
  create: (input) =>
    Effect.tryPromise({
      try: () => import("./Drivers/OpenCodeDriver.ts"),
      catch: (cause) => driverImportError(openCodeDriverKind, input, cause),
    }).pipe(Effect.flatMap(({ OpenCodeDriver }) => OpenCodeDriver.create(input))),
};

const AcpRegistryLazyDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: ProviderDriverKind.make("acpRegistry"),
  metadata: { displayName: "ACP Registry", supportsMultipleInstances: true },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => Schema.decodeSync(AcpRegistrySettings)({}),
  create: (input) =>
    Effect.tryPromise({
      try: () => import("./Drivers/AcpRegistryDriver.ts"),
      catch: (cause) => driverImportError(ProviderDriverKind.make("acpRegistry"), input, cause),
    }).pipe(Effect.flatMap(({ AcpRegistryDriver }) => AcpRegistryDriver.create(input))),
};

/**
 * Ordered list of built-in drivers. Order matters only for tie-breaking in
 * UI presentation — the registry itself is keyed by `driverKind`, so
 * iteration order has no functional effect on instance lookup.
 */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexLazyDriver,
  ClaudeLazyDriver,
  CopilotLazyDriver,
  CursorLazyDriver,
  GrokLazyDriver,
  OpenCodeLazyDriver,
  AcpRegistryLazyDriver,
];
