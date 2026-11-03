import type { ServerSettings } from "@ryco/contracts/settings";
import {
  applyNodeSettingsPatch,
  describeNodeSettingsApplyResult,
  readNodeSettingsAgreement,
  type NodeSettingsAgreement,
  type NodeSettingsConfig,
  type NodeSettingsPatch,
} from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import * as Equal from "effect/Equal";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useSettingsEditingScope } from "../../settingsTarget";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  readNodeSettingsTarget,
  subscribeNodeSettingsTargets,
  useKnownSettingsNodes,
  type KnownSettingsNode,
} from "./nodeSettingsTargets";

/**
 * "Apply to all nodes" on a node setting's row: a bulk edit that writes the
 * value shown to every node this client knows, never a synced global. Nodes
 * that disagree today show "Mixed". Settings route only.
 */

const NO_AGREEMENT: NodeSettingsAgreement<never> = { kind: "none" };

/** Whether fan-out controls show: a node settings row, two or more known nodes, not the frozen phone tier. */
function useFanOutShown(nodes: ReadonlyArray<KnownSettingsNode>): boolean {
  const scope = useSettingsEditingScope();
  const phone = usePresentationTier() === "phone";
  return scope !== "client" && !phone && nodes.length >= 2;
}

/**
 * Whether node rows offer "Apply to all nodes" and may show "Mixed": two or
 * more known nodes, outside the frozen phone tier.
 */
export function useApplyToAllNodesShown(): boolean {
  return useFanOutShown(useKnownSettingsNodes());
}

/**
 * Reads the agreement of `nodes` now; the same agreement keeps its identity,
 * so a config push that changes nothing here (a provider probe) re-renders
 * nothing.
 */
function createAgreementReader<T>(
  nodes: ReadonlyArray<KnownSettingsNode> | null,
  select: (settings: ServerSettings) => T,
  supported: ((config: NodeSettingsConfig) => boolean) | undefined,
): () => NodeSettingsAgreement<T> {
  let last: NodeSettingsAgreement<T> = NO_AGREEMENT;
  return () => {
    if (nodes === null) return NO_AGREEMENT;
    const next = readNodeSettingsAgreement(
      nodes.map(readNodeSettingsTarget),
      select,
      supported === undefined ? undefined : { supported },
    );
    if (Equal.equals(next, last)) return last;
    last = next;
    return next;
  };
}

function useAgreement<T>(
  nodes: ReadonlyArray<KnownSettingsNode>,
  select: (settings: ServerSettings) => T,
  supported: ((config: NodeSettingsConfig) => boolean) | undefined,
): NodeSettingsAgreement<T> {
  // One node can never disagree with itself: nothing is read or watched then.
  const watched = nodes.length >= 2 ? nodes : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      watched === null
        ? () => undefined
        : subscribeNodeSettingsTargets(
            watched.map((node) => node.environmentId),
            listener,
          ),
    [watched],
  );
  const read = useMemo(
    () => createAgreementReader(watched, select, supported),
    [select, supported, watched],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Whether the connected nodes this client knows agree on a setting, read from
 * each node's own config. Pass module-level `select` and `supported`.
 */
export function useNodeSettingsAgreement<T>(
  select: (settings: ServerSettings) => T,
  supported?: (config: NodeSettingsConfig) => boolean,
): NodeSettingsAgreement<T> {
  return useAgreement(useKnownSettingsNodes(), select, supported);
}

/** "Mixed" when the nodes disagree; its tooltip lists each node's value. */
export function MixedNodesBadge<T>(props: {
  readonly agreement: NodeSettingsAgreement<T>;
  readonly format: (value: T) => string;
}) {
  if (props.agreement.kind !== "mixed") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant="warning" size="sm" tabIndex={0} data-testid="settings-mixed-badge">
            Mixed
          </Badge>
        }
      />
      <TooltipPopup side="top" align="start">
        <span className="block py-0.5 font-medium">Differs across your nodes</span>
        {props.agreement.values.map((entry) => (
          <span key={entry.label} className="block py-0.5 text-muted-foreground">
            {entry.label}: {props.format(entry.value)}
          </span>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}

export interface ApplyToAllNodesProps<T> {
  /** The setting's name in a sentence ("worktree setup"), for the button's accessible name. */
  readonly label: string;
  /** Each node's value of the setting, compared for "Mixed". Pass a stable function. */
  readonly select: (settings: ServerSettings) => T;
  /** How a value reads in the "Mixed" tooltip. */
  readonly format: (value: T) => string;
  /**
   * What every node is sent. A patch with compare-and-set values must be built
   * from each node's own config, never copied from the node on screen.
   */
  readonly patch: NodeSettingsPatch;
  /** Whether a node knows the setting, from its own config. Pass a stable function. */
  readonly supported?: (config: NodeSettingsConfig) => boolean;
  readonly disabled?: boolean;
}

/**
 * The row's "Mixed" badge, its "Apply to all nodes" button and the result
 * line, for the row's status slot. Renders nothing with fewer than two known
 * nodes, on client rows, and on the frozen phone tier.
 */
export function ApplyToAllNodes<T>(props: ApplyToAllNodesProps<T>) {
  const nodes = useKnownSettingsNodes();
  const shown = useFanOutShown(nodes);
  const agreement = useAgreement(nodes, props.select, props.supported);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (!shown) return null;

  const apply = () => {
    setBusy(true);
    setStatus(null);
    void applyNodeSettingsPatch(
      nodes.map(readNodeSettingsTarget),
      props.patch,
      props.supported === undefined ? undefined : { supported: props.supported },
    )
      .then((result) => setStatus(describeNodeSettingsApplyResult(result)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
      <MixedNodesBadge agreement={agreement} format={props.format} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              disabled={busy || props.disabled === true}
              aria-label={`Apply to all nodes: ${props.label}`}
              onClick={apply}
            >
              {busy ? "Applying…" : "Apply to all nodes"}
            </Button>
          }
        />
        <TooltipPopup side="top">
          Writes this value to every connected node you own. Offline nodes keep their value.
        </TooltipPopup>
      </Tooltip>
      {status ? (
        <span role="status" className="basis-full">
          {status}
        </span>
      ) : null}
    </div>
  );
}
