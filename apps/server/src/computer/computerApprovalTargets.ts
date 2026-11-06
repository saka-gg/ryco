import { computerAppApprovalKey, computerAppDisplayName } from "@ryco/shared/computerAppApprovals";

import type { ComputerApprovalApp } from "./ComputerApprovalGate.ts";
import { ComputerDenylistError, computerDenylistMatch } from "./computerDenylist.ts";

/** What one tool call says it will act on, before anything is dispatched. */
export interface ComputerApprovalTargets {
  readonly windowIds: readonly string[];
  readonly pids: readonly number[];
  readonly apps: readonly string[];
}

/** The app names a call's targets resolve to; `unresolved` when one could not be named. */
export interface ComputerApprovalAppNames {
  readonly names: readonly string[];
  readonly unresolved: boolean;
}

/** A target that cannot be named; it is allowed for one chat at most. */
export const COMPUTER_APPROVAL_UNNAMED_APP: ComputerApprovalApp = {
  key: "\u0000mac",
  name: "your Mac",
  canAlwaysAllow: false,
};
/**
 * Collects target ids from a call's arguments: the call itself, drag endpoints and every
 * step of a batch. Element refs resolve to the window they were observed in.
 */
export function collectComputerApprovalTargets(
  args: Record<string, unknown>,
  refWindow: (ref: number) => string | undefined = () => undefined,
): ComputerApprovalTargets {
  const windowIds = new Set<string>();
  const pids = new Set<number>();
  const apps = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return;
    const record = value as Record<string, unknown>;
    for (const key of ["window_id", "windowId"]) {
      const id = record[key];
      if (typeof id === "string" && id.length > 0 && id.length <= 256) windowIds.add(id);
    }
    if (typeof record.ref === "number") {
      const id = refWindow(record.ref);
      if (id !== undefined) windowIds.add(id);
    }
    if (typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0)
      pids.add(record.pid);
    if (typeof record.app === "string" && record.app.trim().length > 0 && record.app.length <= 512)
      apps.add(record.app.trim());
    visit(record.from, depth + 1);
    visit(record.to, depth + 1);
    if (depth === 0 && Array.isArray(record.steps))
      for (const step of record.steps.slice(0, 64)) visit(step, depth + 1);
  };
  visit(args, 0);
  return { windowIds: [...windowIds], pids: [...pids], apps: [...apps] };
}

/**
 * Whether a call names nothing it acts on. A browser call like that only launches the
 * driver's own isolated browser (no page, no user profile), so it asks nothing; the first
 * action in that browser asks for it by name.
 */
export function computerApprovalTargetsEmpty(targets: ComputerApprovalTargets): boolean {
  return targets.windowIds.length === 0 && targets.pids.length === 0 && targets.apps.length === 0;
}

/**
 * The apps one call needs approval for, deduplicated. A denylisted app is refused here,
 * before any dialog, with the same error the manager gives at dispatch. A call that names
 * nothing (a coordinate on whatever window is there) asks for the unnamed target.
 */
export function computerApprovalAppsFor(resolved: ComputerApprovalAppNames): ComputerApprovalApp[] {
  const apps = new Map<string, ComputerApprovalApp>();
  for (const raw of resolved.names) {
    const name = computerAppDisplayName(raw);
    const key = computerAppApprovalKey(name);
    if (!key) continue;
    const denied = computerDenylistMatch({ name: raw });
    if (denied) throw new ComputerDenylistError(denied.app, denied.matched);
    if (!apps.has(key)) apps.set(key, { key, name, canAlwaysAllow: true });
  }
  if (resolved.unresolved || apps.size === 0)
    apps.set(COMPUTER_APPROVAL_UNNAMED_APP.key, COMPUTER_APPROVAL_UNNAMED_APP);
  return [...apps.values()];
}
