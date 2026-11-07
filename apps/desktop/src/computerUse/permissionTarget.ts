import type * as ChildProcess from "node:child_process";

import { resolveMacAppBundle } from "../macAppBundle.ts";
import { findComputerUseHelperApp, type ComputerUseHelperApp } from "./helperApp.ts";
import { ComputerUseHelperBroker, type ComputerUseSpawn } from "./helperBroker.ts";

/** The app bundle macOS gives Computer Use's privacy grants to, as System Settings lists it. */
export interface ComputerUsePermissionTarget {
  /** The exact bundle setup registers and guides; absent outside an app bundle (dev launchers). */
  readonly bundlePath: string | undefined;
  readonly bundleId: string;
  /** The name System Settings shows for it. */
  readonly displayName: string;
  /** Ryco's own bundle id: Ryco's windows stay out of capture whoever holds the grants. */
  readonly hostBundleId: string;
  /**
   * Ryco Computer Use, when it holds the grants. Every program that needs them must then start
   * as its child, through `spawn`; without it they run under Ryco, as before the helper app.
   */
  readonly helper: ComputerUseHelperApp | undefined;
}

/**
 * The one place that decides which bundle receives Computer Use's macOS grants: Ryco Computer
 * Use when the build carries it, otherwise the running Ryco app.
 */
export function resolveComputerUsePermissionTarget(input: {
  readonly executablePath: string;
  readonly platform: NodeJS.Platform;
  readonly appName: string;
  readonly isPackaged: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly findHelper?: typeof findComputerUseHelperApp;
}): ComputerUsePermissionTarget {
  const host = resolveMacAppBundle(input.executablePath, input.platform);
  const helper = (input.findHelper ?? findComputerUseHelperApp)({
    hostBundlePath: host.bundlePath,
    platform: input.platform,
    isPackaged: input.isPackaged,
    env: input.env ?? process.env,
  });
  return helper
    ? {
        bundlePath: helper.bundlePath,
        bundleId: helper.bundleId,
        displayName: helper.displayName,
        hostBundleId: host.bundleId,
        helper,
      }
    : {
        bundlePath: host.bundlePath,
        bundleId: host.bundleId,
        displayName: input.appName,
        hostBundleId: host.bundleId,
        helper: undefined,
      };
}

export interface ComputerUseGrantRuntime {
  readonly target: ComputerUsePermissionTarget;
  /** Starts programs that need the grants; undefined runs them as Ryco's own children. */
  readonly spawn: ComputerUseSpawn | undefined;
}

let shared: ComputerUseGrantRuntime | undefined;

/**
 * Computer Use and composer window capture share one target and one helper process: they need
 * the same grants, and macOS should list one app for them.
 */
export function sharedComputerUseGrantRuntime(
  input: Parameters<typeof resolveComputerUsePermissionTarget>[0],
): ComputerUseGrantRuntime {
  if (shared) return shared;
  const target = resolveComputerUsePermissionTarget(input);
  if (!target.helper && input.platform === "darwin")
    console.info(
      "[computer-use-helper] Ryco Computer Use not found; Computer Use runs under Ryco itself.",
    );
  const broker = target.helper ? new ComputerUseHelperBroker({ app: target.helper }) : undefined;
  // The helper exits when Ryco's socket closes anyway; this also removes the broker directory.
  if (broker) process.once("exit", () => broker.dispose());
  shared = { target, spawn: broker?.spawn };
  return shared;
}

/** The broker's spawn for owners typed against Node's `spawn` (they use only its common shape). */
export function asNodeSpawn(
  spawn: ComputerUseSpawn | undefined,
): typeof ChildProcess.spawn | undefined {
  return spawn as unknown as typeof ChildProcess.spawn | undefined;
}
