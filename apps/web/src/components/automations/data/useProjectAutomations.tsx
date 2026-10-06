import type {
  AutomationCentreSnapshot,
  EnvironmentId,
  ProjectId,
  ServerProvider,
} from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../../env";
import { useEvent } from "../../../hooks/useEvent";
import { retainDesktopWorkspaceInteractiveScope } from "../../../platform/desktopWorkspace";
import { projectCheckoutKey } from "../../../projectCheckouts.logic";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import {
  useEnvironmentPresence,
  type EnvironmentPresence,
} from "../../projects/useEnvironmentPresence";
import { useAutomationCentre, type AutomationCentreState } from "../useAutomationCentre";
import { useAutomationProposalSync } from "./useAutomationProposalSync";

/** One checkout of a project — a device — with its schedules, runs and pending approvals. */
export interface ProjectAutomationsCheckout {
  /** `projectCheckoutKey(environmentId, projectId)`: stable, unique within the project. */
  readonly key: string;
  readonly member: SidebarProjectGroupMember;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** "This device" for the device the app runs on, else the device's name. */
  readonly deviceLabel: string;
  readonly isPrimary: boolean;
  readonly presence: EnvironmentPresence;
  /** Null until the first read lands, and while the device is unreachable. */
  readonly snapshot: AutomationCentreSnapshot | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly error: string | null;
  /** A save, cancel, retry, read or decision is in flight on this checkout. */
  readonly busy: boolean;
  /** Why changes are off for this reader (hosted role), or null. */
  readonly disabledReason: string | null;
  /** Save, cancel, retry or mark read; resolves true once the server took it. Stable identity. */
  readonly command: AutomationCentreState["command"];
  /** Approve or reject a proposal or a waiting run. Stable identity. */
  readonly decide: AutomationCentreState["decide"];
  /** Re-read the checkout now. Stable identity. */
  readonly refresh: () => void;
}

/** Reads one checkout and reports it up; renders nothing. */
function CheckoutAutomationsSource(props: {
  readonly member: SidebarProjectGroupMember;
  readonly onChange: (key: string, checkout: ProjectAutomationsCheckout | null) => void;
}) {
  const { member, onChange } = props;
  const environmentId = member.environmentId;
  const key = projectCheckoutKey(environmentId, member.id);
  const { isPrimary, label, status } = useEnvironmentPresence(environmentId);
  // A checkout on another desktop Hub machine connects on demand: hold it
  // while its schedules are shown, as the project map does.
  useEffect(() => {
    if (!isElectron || isPrimary) return;
    return retainDesktopWorkspaceInteractiveScope(environmentId);
  }, [environmentId, isPrimary]);
  // Lapsed proposals only live in the device's Agent Control queue.
  useAutomationProposalSync([environmentId]);

  const centre = useAutomationCentre(environmentId, member.id);
  const command = useEvent(centre.command);
  const decide = useEvent(centre.decide);
  const refresh = useEvent(centre.refresh);
  const presence = useMemo<EnvironmentPresence>(
    () => ({ environmentId, isPrimary, label, status }),
    [environmentId, isPrimary, label, status],
  );

  const checkout = useMemo<ProjectAutomationsCheckout>(
    () => ({
      key,
      member,
      environmentId,
      projectId: member.id,
      deviceLabel: presence.label,
      isPrimary: presence.isPrimary,
      presence,
      snapshot: centre.snapshot,
      providers: centre.providers,
      error: centre.error,
      busy: centre.busy,
      disabledReason: centre.disabledReason,
      command,
      decide,
      refresh,
    }),
    [
      centre.busy,
      centre.disabledReason,
      centre.error,
      centre.providers,
      centre.snapshot,
      command,
      decide,
      environmentId,
      key,
      member,
      presence,
      refresh,
    ],
  );

  useEffect(() => onChange(key, checkout), [checkout, key, onChange]);
  useEffect(() => () => onChange(key, null), [key, onChange]);
  return null;
}

export interface ProjectAutomations {
  /** The project's checkouts: this device first, then the others in the project's order. */
  readonly checkouts: readonly ProjectAutomationsCheckout[];
  /** Some checkout has not reported a snapshot or an error yet. */
  readonly loading: boolean;
  /** Render somewhere in the tree; `checkouts` follows them. */
  readonly sources: ReactNode;
}

/**
 * Every checkout of a logical project, read live side by side, so one dialog
 * can show a project's schedules across its devices. Each checkout keeps its
 * device's Agent Control queue synced. Identities are stable: a checkout
 * object changes only when its own data does.
 */
export function useProjectAutomations(snapshot: SidebarProjectSnapshot): ProjectAutomations {
  const [byKey, setByKey] = useState<ReadonlyMap<string, ProjectAutomationsCheckout>>(new Map());
  const onChange = useCallback((key: string, checkout: ProjectAutomationsCheckout | null) => {
    setByKey((current) => {
      if (current.get(key) === checkout || (!checkout && !current.has(key))) return current;
      const next = new Map(current);
      if (checkout) next.set(key, checkout);
      else next.delete(key);
      return next;
    });
  }, []);
  const members = snapshot.memberProjects;
  const checkouts = useMemo(
    () =>
      members
        .map((member) => byKey.get(projectCheckoutKey(member.environmentId, member.id)))
        .filter((checkout): checkout is ProjectAutomationsCheckout => checkout !== undefined)
        .toSorted((left, right) => Number(right.isPrimary) - Number(left.isPrimary)),
    [byKey, members],
  );
  const loading =
    checkouts.length < members.length ||
    checkouts.some((checkout) => checkout.snapshot === null && checkout.error === null);
  const sources = members.map((member) => (
    <CheckoutAutomationsSource
      key={projectCheckoutKey(member.environmentId, member.id)}
      member={member}
      onChange={onChange}
    />
  ));
  return { checkouts, loading, sources };
}
