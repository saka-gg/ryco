import {
  describePullRequestsListError,
  describeSourceControlError,
} from "@ryco/client-runtime/state/pull-request-review";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { readSourceControlFailure } from "@ryco/shared/sourceControlFailure";

import { nodeRoleAllows, type NodeSessionRole } from "../../connection/nodeRoleAccess";

/**
 * What the project explorer screens share: the tabs, route params, and how a
 * failed read is put to the reader. React-free; the screens only lay it out.
 */

export type ProjectExplorerTab = "issues" | "actions" | "jira";

export const PROJECT_EXPLORER_TABS: ReadonlyArray<{
  readonly value: ProjectExplorerTab;
  readonly label: string;
}> = [
  { value: "issues", label: "Issues" },
  { value: "actions", label: "Actions" },
  { value: "jira", label: "Jira" },
];

import { firstRouteParam, type RouteParam } from "../../lib/routeParams";

export { firstRouteParam };

export interface ExplorerScope {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
}

/** The node and project every explorer route names. */
export function explorerScopeFromParams(params: {
  readonly environmentId?: RouteParam;
  readonly projectId?: RouteParam;
}): ExplorerScope {
  const environmentId = firstRouteParam(params.environmentId);
  const projectId = firstRouteParam(params.projectId);
  return {
    environmentId: environmentId === null ? null : EnvironmentId.make(environmentId),
    projectId: projectId === null ? null : ProjectId.make(projectId),
  };
}

/** The tab a link asks for; anything else opens Issues. */
export function parseProjectExplorerTab(value: RouteParam): ProjectExplorerTab {
  const raw = firstRouteParam(value);
  return PROJECT_EXPLORER_TABS.some((tab) => tab.value === raw)
    ? (raw as ProjectExplorerTab)
    : "issues";
}

/** A Jira key as the host spells it ("ABC-12"); null for anything that is not one. */
export function parseWorkItemKeyParam(value: RouteParam): string | null {
  const raw = firstRouteParam(value);
  if (raw === null) return null;
  const upper = raw.toUpperCase();
  return /^[A-Z][A-Z0-9_]*-\d+$/u.test(upper) ? upper : null;
}

/** A workflow run id (the host's numeric or opaque id); null when missing. */
export function parseRunIdParam(value: RouteParam): string | null {
  const raw = firstRouteParam(value);
  return raw !== null && /^[\w.-]+$/u.test(raw) ? raw : null;
}

// ── Failed reads ─────────────────────────────────────────────────────

/**
 * - `offline`: the node is not connected; reading resumes on reconnect.
 * - `no-remote`: the checkout has no host Ryco recognises; nothing to read.
 * - `unsupported`: the host has no such thing (workflow runs off GitHub/GitLab).
 * - `error`: anything else, in the host's words.
 */
export type ExplorerProblemKind = "offline" | "no-remote" | "unsupported" | "error";

export interface ExplorerProblem {
  readonly kind: ExplorerProblemKind;
  readonly title: string;
  readonly detail: string;
}

const NO_REMOTE_MARKERS = [
  "no recognized source control host",
  "failed to detect source control",
  "detectprovider",
];

/** The failed read of `what` ("issues", "workflow runs"), as the screen states it. */
export function describeExplorerProblem(error: unknown, what: string): ExplorerProblem {
  if (error instanceof Error && error.name === "PullRequestNodeOfflineError") {
    return {
      kind: "offline",
      title: "Node offline",
      detail: `Reconnect to this node to read its ${what}.`,
    };
  }
  const message = describeSourceControlError(error, `The ${what} could not be read.`);
  const lower = message.toLowerCase();
  // A checkout without a recognised host answers every read as the `unknown` provider.
  if (
    readSourceControlFailure(error)?.provider === "unknown" ||
    NO_REMOTE_MARKERS.some((marker) => lower.includes(marker))
  ) {
    return {
      kind: "no-remote",
      title: "No repository host",
      detail: `This project has no GitHub remote, so there are no ${what} to show.`,
    };
  }
  if (lower.includes("is not available for")) {
    return { kind: "unsupported", title: "Not available", detail: message };
  }
  return {
    kind: "error",
    title: `The ${what} could not be read`,
    detail: describePullRequestsListError(message),
  };
}

/** Why a change did not go through, in the host's words. */
export function describeExplorerChangeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === "PullRequestNodeOfflineError") {
    return "Reconnect to this node, then try again.";
  }
  return describeSourceControlError(error, fallback);
}

export const EXPLORER_NOT_READY = "Reconnect to this node to make changes. Reading still works.";

export interface ExplorerChangeOffer {
  /** The session's role may make this change at all; a viewer is not offered it. */
  readonly offered: boolean;
  /** Why an offered change cannot be sent right now; null when it can. */
  readonly blockedReason: string | null;
}

/** Whether a change (`method`, a WS method name) is offered, and whether it can be sent now. */
export function explorerChangeOffer(input: {
  readonly mutationReady: boolean;
  /** The session's role on the node; undefined while unknown (the node then decides). */
  readonly role: NodeSessionRole | undefined;
  readonly method: string;
}): ExplorerChangeOffer {
  const offered = input.role === undefined || nodeRoleAllows(input.role, input.method);
  return { offered, blockedReason: offered && !input.mutationReady ? EXPLORER_NOT_READY : null };
}

/** "+3": rows show at most `visible` chips and count the rest. */
export function splitVisible<T>(
  items: ReadonlyArray<T>,
  visible: number,
): { readonly shown: ReadonlyArray<T>; readonly more: number } {
  const shown = items.slice(0, visible);
  return { shown, more: items.length - shown.length };
}
