/**
 * runtimeMode - The privilege order of runtime modes, shared by every check that keeps a
 * caller from starting work above what it may: Agent Control's plan validation and
 * delegated-result wakes, and `ryco thread start --runtime-mode`.
 *
 * @module runtimeMode
 */
import type { RuntimeMode } from "@ryco/contracts/orchestration";

/** Privilege order of runtime modes: lower is less privileged. */
export const RUNTIME_MODE_RANK: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/** Whether `mode` grants more than `ceiling`. */
export const isRuntimeModeAbove = (mode: RuntimeMode, ceiling: RuntimeMode): boolean =>
  RUNTIME_MODE_RANK[mode] > RUNTIME_MODE_RANK[ceiling];
