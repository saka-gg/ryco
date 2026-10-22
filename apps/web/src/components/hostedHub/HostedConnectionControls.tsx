import type { EnvironmentId } from "@ryco/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BadgeCheckIcon,
  ChevronDownIcon,
  LayoutGridIcon,
  LogOutIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldOffIcon,
  UserRoundIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { navigateHub } from "../../hostedHub/hubRoutes";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DeviceIcon } from "../DeviceIcon";
import { MobileListRow } from "../mobile/MobileListRow";
import {
  MobileSheet,
  MobileSheetDescription,
  MobileSheetHeader,
  MobileSheetPanel,
  MobileSheetTitle,
} from "../mobile/MobileSheet";
import { MobileStatusChip } from "../mobile/MobileStatusChip";
import {
  useHostedDeliveryNotice,
  useHostedEnvironmentDeliveryUnknown,
  useHostedEnvironmentRecord,
} from "../../hostedHub/capabilities";
import type { HostedConnectionStatusIndicator } from "../../hostedHub/connectionStatus";
import {
  leaveHostedNodeRouteToDirectory,
  selectHostedNodeRoute,
  useRoutedHostedNode,
} from "../../hostedHub/nodeRouteOrchestrator";
import { hostedHubController, useHostedHubStore, type HostedHubState } from "../../hostedHub/state";
import type { HostedHubNode } from "../../hostedHub/types";
import {
  useWebE2eeChannelStatus,
  useWebE2eeChannelStatusFor,
} from "../../hostedHub/useWebE2eeSession";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import {
  deriveHostedConnectionChip,
  deriveHostedEnvironmentConnectionChip,
  hostedConnectionAnnouncement,
  hostedConnectionChipQuiet,
  hostedConnectionStatusPresentation,
  type HostedConnectionChip,
  type HostedConnectionChipSource,
  type HostedConnectionGlyph,
} from "./HostedConnectionControls.logic";
import { HostedE2eeVerification } from "./HostedE2eeVerification";
import { HostedPwaControls } from "./HostedPwaControls";
import {
  useHostedReadCache,
  canShowHostedReadPreview,
  setHostedReadCacheEnabled,
} from "../../hostedHub/readCache";

/**
 * The one place a glyph name becomes a glyph. Everything that DECIDES which name
 * applies lives in `HostedConnectionControls.logic.ts`, so the decision is
 * assertable without a DOM and this map holds no policy at all.
 */
const HOSTED_CONNECTION_GLYPHS: Record<HostedConnectionGlyph, LucideIcon> = {
  connected: WifiIcon,
  disconnected: WifiOffIcon,
  legacy: ShieldOffIcon,
  "browser-encrypted": ShieldIcon,
  "account-trusted": BadgeCheckIcon,
  "native-verified": ShieldCheckIcon,
};

/**
 * The status glyph every hosted connection surface draws.
 *
 * Shared rather than repeated three times because it is the §2.2 decision, not a
 * decoration: three copies of a conditional are three chances for one of them to
 * key on `connected` again and hand `docs/relay-e2ee-protocol.md` §12.2's
 * fallback the colour a locked channel gets. `data-connected` stays on the
 * element for the reachability assertions that already read it, and
 * `data-guarantee` carries the claim beside it.
 */
function HostedConnectionStatusIcon({
  indicator,
  className,
  testId,
}: {
  readonly indicator: HostedConnectionStatusIndicator;
  readonly className: string;
  readonly testId?: string;
}) {
  const { glyph, iconClassName } = hostedConnectionStatusPresentation(indicator);
  const Icon = HOSTED_CONNECTION_GLYPHS[glyph];
  return (
    <Icon
      aria-hidden
      data-testid={testId}
      data-connected={String(indicator.connected)}
      data-guarantee={indicator.guarantee}
      data-glyph={glyph}
      className={`${className} ${iconClassName}`}
    />
  );
}

export function NodePresence({ node }: { readonly node: HostedHubNode }) {
  if (node.revokedAt) return <span className="text-xs text-destructive">Revoked</span>;
  return node.presence.online ? (
    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
      <WifiIcon aria-hidden className="size-3.5" /> Online
    </span>
  ) : (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <WifiOffIcon aria-hidden className="size-3.5" /> Offline
    </span>
  );
}

export function useHostedConnectionActions() {
  const navigate = useNavigate();

  // Opens home with the selection cursor on the chosen node.
  const switchNode = async (next: HostedHubNode) => {
    if (selectHostedNodeRoute(next.id)) return;
    await navigate({ to: "/", replace: true });
    await hostedHubController.selectNode(next.id);
  };

  // Moves the selection cursor to another node and stays on the current page.
  // Its caller is Settings, a page no node owns, so the address stays as it is
  // and the cursor moves through the lifecycle owner's own select, which
  // connects nothing: the page holds the demand for the node it shows.
  const switchNodeInPlace = async (next: HostedHubNode) => {
    await hostedHubController.selectNode(next.id);
  };

  // "All nodes" releases this route's demand and opens the Hub catalog. The
  // selection cursor stays where it is, and the coordinator, not navigation,
  // decides whether a retained/LRU connection remains live.
  const returnToAllNodes = async () => {
    if (leaveHostedNodeRouteToDirectory()) return;
    await navigate({ to: "/", replace: true });
    await hostedHubController.returnToDirectory();
  };

  return { switchNode, switchNodeInPlace, returnToAllNodes };
}

/** The hosted fields every connection chip reads, picked once for both chips. */
const selectHostedConnectionChipSource = (state: HostedHubState): HostedConnectionChipSource => ({
  accountStatus: state.accountStatus,
  directoryStatus: state.directoryStatus,
  browserStatus: state.browserStatus,
  selectionStatus: state.selectionStatus,
  transportStatus: state.transportStatus,
  sessionStatus: state.sessionStatus,
  errorMessage: state.errorMessage,
  effectiveRole: state.effectiveRole,
  selectedNode: state.selectedNode,
  nodes: state.nodes,
});

/**
 * The one place the hosted state becomes what the phone connection surfaces
 * show: the selected node they name and its bounded status, including the
 * channel state (docs/relay-e2ee-protocol.md §12.2 asks for it on every
 * user-facing surface). Returns null while there is no node to name, which also
 * covers every non-hosted mode.
 */
function useHostedConnectionChip(): HostedConnectionChip | null {
  const source = useHostedHubStore(useShallow(selectHostedConnectionChipSource));
  const routedNodeId = useRoutedHostedNode().nodeId;
  const e2eeStatus = useWebE2eeChannelStatus();
  return useMemo(
    () => deriveHostedConnectionChip({ ...source, routedNodeId, e2eeStatus }),
    [e2eeStatus, routedNodeId, source],
  );
}

/**
 * The same chip for one named environment — the open thread's — whether or not
 * the selection cursor is on it: the shared session fields while it is
 * selected, its own session record otherwise, and its own channel always.
 * Null while the directory does not list its node.
 */
function useHostedEnvironmentConnectionChip(
  environmentId: EnvironmentId,
): HostedConnectionChip | null {
  const source = useHostedHubStore(useShallow(selectHostedConnectionChipSource));
  const other = source.selectedNode?.environmentId !== environmentId;
  const record = useHostedEnvironmentRecord(other ? environmentId : null);
  const deliveryUnknown = useHostedEnvironmentDeliveryUnknown(other ? environmentId : null);
  const e2eeStatus = useWebE2eeChannelStatusFor(environmentId);
  return useMemo(
    () =>
      deriveHostedEnvironmentConnectionChip({
        ...source,
        environmentId,
        record,
        deliveryUnknown,
        e2eeStatus,
      }),
    [deliveryUnknown, e2eeStatus, environmentId, record, source],
  );
}

/** The delivery-unknown warning and its replay-gated acknowledgement. */
function DeliveryUnknownNotice({
  recovered,
  onAcknowledge,
}: {
  readonly recovered: boolean;
  readonly onAcknowledge: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
    >
      <p>A request may or may not have reached the node. Ryco did not resend it automatically.</p>
      <Button
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={!recovered}
        title={
          recovered
            ? undefined
            : "Wait for session replay to finish before acknowledging this warning."
        }
        onClick={onAcknowledge}
      >
        {recovered ? "Acknowledge" : "Synchronizing…"}
      </Button>
    </div>
  );
}

/** The selected node's unconfirmed delivery, for the phone connection sheet. */
function DeliveryUnknownAcknowledgement() {
  const session = useHostedHubStore((state) => state.sessionStatus);
  const recoveredAfterUnknown = useHostedHubStore((state) => state.sessionRecoveredAfterUnknown);
  if (session !== "delivery-unknown") return null;
  return (
    <DeliveryUnknownNotice
      recovered={recoveredAfterUnknown}
      onAcknowledge={() => hostedHubController.acknowledgeDeliveryUnknown()}
    />
  );
}

/**
 * One environment's unconfirmed delivery: the selected one's from the shared
 * session, any other one's from its own record, acknowledged where it lives.
 */
function EnvironmentDeliveryUnknownAcknowledgement({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const notice = useHostedDeliveryNotice(environmentId);
  if (!notice) return null;
  return (
    <DeliveryUnknownNotice recovered={notice.canAcknowledge} onAcknowledge={notice.acknowledge} />
  );
}

/**
 * What the thread header shows for a thread the browser can only read from its
 * saved copy: no node to describe, a fresh connection on its way. Renders
 * nothing unless that saved copy is what is on screen.
 */
function HostedSavedViewMenu() {
  const readCache = useHostedReadCache();
  if (!readCache.accountId || !canShowHostedReadPreview()) return null;
  return (
    <details className="relative text-xs">
      <summary className="cursor-pointer rounded-lg px-3 py-2 text-muted-foreground">
        Saved view · Reconnecting
      </summary>
      <div className="absolute right-0 z-50 mt-2 grid w-64 gap-2 rounded-lg border bg-popover p-3 shadow-md">
        <p>Reading saved text. Sending work waits for a fresh connection.</p>
        <Button variant="ghost" size="sm" onClick={() => void hostedHubController.bootstrap()}>
          Retry connection
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void setHostedReadCacheEnabled(false)}>
          Forget saved conversations
        </Button>
      </div>
    </details>
  );
}

/**
 * The open thread's connection, in the desktop workspace header: the thread's
 * own node and its bounded status, whichever node the selection cursor is on.
 *
 * It is a location, not a switch. Nodes stay connected in the background, so
 * the header names where this thread runs and over what channel, and nothing
 * else; switching happens by opening another node's thread, and the node list
 * lives on the device directory the popover links to. Renders in normal flow
 * inside the header's inline actions, so it can never overlap other controls.
 *
 * The steady browser channel is drawn quietly and every other state keeps its
 * outline, and every state keeps its word and its glyph (text and icon, never
 * colour alone). Renders nothing outside hosted sessions.
 */
export function HostedThreadConnectionBadge({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const chip = useHostedEnvironmentConnectionChip(environmentId);
  const selected = useHostedHubStore(
    (state) => state.selectedNode?.environmentId === environmentId,
  );
  const error = useHostedHubStore((state) => state.errorMessage);
  const { returnToAllNodes } = useHostedConnectionActions();
  const disclosureRef = useRef<HTMLDetailsElement>(null);
  if (!chip) return <HostedSavedViewMenu />;

  const { node, role, statusText, indicator } = chip;
  const quiet = hostedConnectionChipQuiet(indicator);

  return (
    <div className="relative max-w-full">
      <details ref={disclosureRef} className="group relative">
        <summary
          data-quiet={String(quiet)}
          className={cn(
            "flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
            quiet
              ? "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              : "border border-border bg-card/95 text-foreground",
          )}
        >
          <DeviceIcon
            environmentId={node.environmentId}
            label={node.label}
            platformOs={node.platformOs}
            className="size-3.5 shrink-0"
          />
          <span className="max-w-32 truncate font-medium">{node.label}</span>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          {/* The glyph follows the derived state and the §2.2 claim, not the
              transport: read off `transportStatus` alone it drew the connected
              green wifi beside `Delivery unknown`, beside `Authorization
              removed`, and beside a §12.2 plaintext fallback. */}
          <HostedConnectionStatusIcon indicator={indicator} className="size-3.5 shrink-0" />
          <span className="whitespace-nowrap">{statusText}</span>
          <ChevronDownIcon
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-border bg-popover p-3 shadow-xl">
          <p className="font-medium">{node.label}</p>
          <p className="mt-0.5 text-xs capitalize text-muted-foreground">
            {role ?? "Role unavailable"} · {statusText}
          </p>
          <p className="sr-only" aria-live="polite">
            {hostedConnectionAnnouncement(node.label, statusText)}
          </p>
          {/* The shared error describes the selected node only. */}
          {selected && error ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {error}
            </p>
          ) : null}
          <EnvironmentDeliveryUnknownAcknowledgement environmentId={environmentId} />
          <div className="mt-3 space-y-3 border-t border-border pt-3 empty:hidden">
            {/* §13.5's surface duty: "Shown in the web UI for the active
                session … the owner compares the two out of band." The code is
                this thread's node's own session code, for every role. It
                renders itself only on a locked `e2ee` channel and returns null
                in every other state, so this mount site carries no condition of
                its own that could disagree with the projection. */}
            <HostedE2eeVerification environmentId={environmentId} />
          </div>
          <div className="mt-3 border-t border-border pt-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // Close first: the directory replaces the workspace, and a
                // disclosure left open would come back open with it.
                if (disclosureRef.current) disclosureRef.current.open = false;
                void returnToAllNodes();
              }}
            >
              <LayoutGridIcon aria-hidden /> Manage devices
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

/**
 * The phone connection sheet: the full hosted connection control set as a
 * bottom sheet — node status and effective role, delivery-unknown
 * acknowledgment, "All nodes" (close the browser relay session and return to
 * the directory), node switching with the directory's fail-closed disables,
 * directory refresh, install/update controls, security navigation, and
 * sign out. Sign out stays available in every state.
 */
export function HostedConnectionSheet({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const chip = useHostedConnectionChip();
  const nodes = useHostedHubStore((state) => state.nodes);
  const directory = useHostedHubStore((state) => state.directoryStatus);
  const error = useHostedHubStore((state) => state.errorMessage);
  const browserStatus = useHostedHubStore((state) => state.browserStatus);
  const { switchNode, returnToAllNodes } = useHostedConnectionActions();
  if (!chip) return null;

  const { node, role, statusText, indicator } = chip;
  const switchingDisabled = directory !== "ready" || browserStatus !== "current";

  return (
    <MobileSheet open={open} onOpenChange={onOpenChange} label="Connection">
      <MobileSheetHeader>
        <MobileSheetTitle className="flex items-center gap-2">
          {/* The glyph follows the derived state and the §2.2 claim, not the
              transport and not connectedness alone: a §12.2 fallback and a
              locked channel are both usable sessions, so keyed on `connected`
              they drew the same green wifi. */}
          <HostedConnectionStatusIcon indicator={indicator} className="size-4" />
          <span className="truncate">{node.label}</span>
        </MobileSheetTitle>
        <MobileSheetDescription className="capitalize">
          {role ?? "Role unavailable"} · {statusText}
        </MobileSheetDescription>
        <p className="sr-only" aria-live="polite">
          {hostedConnectionAnnouncement(node.label, statusText)}
        </p>
      </MobileSheetHeader>
      <MobileSheetPanel>
        {error ? (
          <p role="status" className="text-xs text-muted-foreground">
            {error}
          </p>
        ) : null}
        <DeliveryUnknownAcknowledgement />
        <div className="mt-3 space-y-1 border-t border-border pt-3">
          <MobileListRow
            label="Security details"
            icon={<UserRoundIcon aria-hidden className="size-4 shrink-0" />}
            onClick={() => {
              // Close first: the settings surface is its own full-screen sheet
              // and must not open behind this one.
              onOpenChange(false);
              navigateHub({ kind: "account", section: "security" });
            }}
          />
          <MobileListRow
            label="All nodes"
            icon={<LayoutGridIcon aria-hidden className="size-4 shrink-0" />}
            onClick={() => {
              onOpenChange(false);
              void returnToAllNodes();
            }}
          />
          {nodes
            .filter((candidate) => candidate.id !== node.id)
            .map((candidate) => (
              <MobileListRow
                key={candidate.id}
                label={candidate.label}
                disabled={
                  switchingDisabled ||
                  candidate.revokedAt !== null ||
                  candidate.capabilities?.nativeClientRequired === true
                }
                disabledReason={
                  candidate.capabilities?.nativeClientRequired === true
                    ? "Open in Desktop/Mobile"
                    : candidate.revokedAt !== null
                      ? "Access to this node was revoked."
                      : "Node switching is unavailable until the directory and this browser are current."
                }
                trailing={<NodePresence node={candidate} />}
                onClick={() => {
                  onOpenChange(false);
                  void switchNode(candidate);
                }}
              />
            ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={directory === "loading"}
            onClick={() => void hostedHubController.refreshDirectory()}
          >
            <RefreshCwIcon aria-hidden /> Refresh nodes
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11"
            onClick={() => void hostedHubController.signOut()}
          >
            <LogOutIcon aria-hidden /> Sign out
          </Button>
        </div>
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <HostedPwaControls compact />
        </div>
      </MobileSheetPanel>
    </MobileSheet>
  );
}

/**
 * The phone connection indicator: the collapsed `MobileStatusChip` hosted by
 * the phone app bars, which expands into the connection sheet on tap. Returns
 * null while no node is selected, which also covers non-hosted modes.
 *
 * The audited pill measured 176×36 and rendered the node label and the state
 * both truncated to unreadability, crowding the app-bar title out at 320 px.
 * Collapsed, the chip renders the icon plus a chosen short label for the
 * derived state: the node label is what yields, because it is the half a
 * reader still receives — the accessible label carries node identity and the
 * COMPLETE bounded status text at collapsed size, and the expanded sheet
 * carries the full text alongside the bounded control set.
 *
 * The two live regions are deliberately siblings of the chip rather than
 * children of it, so shrinking the visible control cannot take them with it.
 */
export function HostedConnectionPill() {
  const chip = useHostedConnectionChip();
  const session = useHostedHubStore((state) => state.sessionStatus);
  const [open, setOpen] = useState(false);
  if (!chip) return null;

  const { node, statusText, indicator } = chip;

  return (
    <>
      {/* Sheet-closed announcements: every derived status change announces
          politely, and delivery-unknown arrival announces assertively — its
          explicit acknowledgment flow lives in the connection sheet. While
          the sheet is open its own live regions cover both, so the pill's
          copies unmount to avoid double announcements. */}
      {open ? null : (
        <>
          <span
            role="status"
            aria-live="polite"
            data-testid="hosted-connection-status-announcer"
            className="sr-only"
          >
            {hostedConnectionAnnouncement(node.label, statusText)}
          </span>
          {session === "delivery-unknown" ? (
            <span role="alert" className="sr-only">
              Delivery unknown: a request may or may not have reached the node. Open the connection
              controls to acknowledge.
            </span>
          ) : null}
        </>
      )}
      <MobileStatusChip
        testId="hosted-connection-pill"
        // Node identity and the COMPLETE bounded status text stay in the
        // accessible name at collapsed size. The visible word is the runtime's
        // CHOSEN short label, never a token of the text: the leading token
        // stripped polarity exactly where polarity is the message, and
        // `HOSTED_CONNECTION_STATUS_INDICATORS` exists to replace it.
        label={`Connection: ${node.label}, ${statusText}`}
        status={indicator.shortLabel}
        // The glyph follows the same gate order as the text, and then the §2.2
        // claim. Choosing it from `transport === "online"` alone put a green
        // connected icon beside `Delivery unknown`, beside `Authorization
        // removed`, and beside a closed ryco session — the states where the icon
        // is doing the most work, because the collapsed chip has no room to
        // explain itself. Choosing it from `connected` alone drew the same green
        // icon for a §12.2 plaintext fallback and for a locked channel.
        icon={
          <HostedConnectionStatusIcon
            indicator={indicator}
            testId="hosted-connection-icon"
            className="size-3.5 shrink-0"
          />
        }
        onClick={() => setOpen(true)}
      />
      <HostedConnectionSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * The connection control for page chrome that belongs to no thread: the phone
 * pill (opening the bottom sheet) on the phone tier, and nothing on desktop,
 * where nodes stay connected in the background and the open thread's header
 * names its own node (`HostedThreadConnectionBadge`). Renders nothing while no
 * hosted node is selected.
 */
export function HostedConnectionControl() {
  const tier = usePresentationTier();
  return tier === "phone" ? <HostedConnectionPill /> : null;
}
