// The node detail surface: the eight `HostedHubNode` members the directory has
// never rendered, in the tier-forked presentation the rest of the hosted
// surfaces already use.
//
// It exists because the row is a one-click affordance and the metadata is the
// thing you need precisely when that click will not work — a revoked grant, an
// incompatible client version, a node that has not been seen in a week. So the
// control that opens this is never disabled, including for a revoked node and
// including while the directory is stale.

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import type { HostedHubNode } from "../../hostedHub/types";
import {
  MobileSheet,
  MobileSheetDescription,
  MobileSheetFooter,
  MobileSheetHeader,
  MobileSheetPanel,
  MobileSheetTitle,
} from "../mobile/MobileSheet";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { DataList, DataListItem } from "../ui/data-list";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import { NodePresence } from "./HostedConnectionControls";
import { HostedNodeRenameDialog } from "./HostedNodeRenameDialog";
import { HostedNodeRevokeDialog } from "./HostedNodeRevokeDialog";
import { HOSTED_NODE_REVOKE_ACTION_LABEL } from "@ryco/client-runtime/machineAccess/hostedNodeRevoke";
import {
  formatEpoch,
  nodeMetaLine,
  nodeSelectionBlocked,
  nodeSelectionBlockedReason,
  platformLabel,
  relativeTime,
  roleLabel,
} from "./HostedNodeDisplay.logic";

export interface HostedNodeDetailProps {
  /**
   * The node as the store holds it **right now**, or `null` when the sheet is
   * closed. The caller must re-resolve this from `hostedHubStore.nodes` on
   * every render rather than holding the object the sheet was opened with:
   * presence, `clientVersion`, and above all `revokedAt` are replaced by a
   * 20-second poll, and every claim below — including `Connect`'s own enabled
   * state — is read straight off whatever is passed here.
   */
  readonly node: HostedHubNode | null;
  readonly directoryStatus: string;
  readonly browserStatus: string;
  readonly canRename: boolean;
  /**
   * Whether this account may revoke the node. Owner-only, exactly like rename —
   * the Hub answers `node_forbidden` to anyone else, so rendering a control that
   * can only ever be refused would be an offer this Hub does not make.
   */
  readonly canRevoke: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConnect: (node: HostedHubNode) => void;
  readonly onRename: (node: HostedHubNode, label: string) => Promise<void>;
  /**
   * Performs the revocation and resolves only once the Hub has confirmed it.
   *
   * Deliberately NOT presence-gated. Revocation is Hub-side state and reaches
   * nothing on the machine, so an offline, unreachable, or permanently gone node
   * is revoked by the same call — and that is precisely the node an owner is
   * trying to get rid of. Gating this on presence would disable the control in
   * exactly the case it exists for, which is the mistake `Connect` is allowed to
   * make and this is not.
   */
  readonly onRevoke: (node: HostedHubNode) => Promise<void>;
}

function NodeDetailBody({ node }: { readonly node: HostedHubNode }) {
  const nowMs = useRelativeTimeTick(60_000);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const enrolled = formatEpoch(node.createdAt);
  const lastConnected = formatEpoch(node.lastAuthenticatedAt);
  const revoked = formatEpoch(node.revokedAt);
  const grantDiffers = node.grant.role !== node.effectiveRole;

  return (
    <DataList>
      <DataListItem term="Status">
        <NodePresence node={node} />
      </DataListItem>
      <DataListItem term="Last heartbeat">
        {node.presence.lastHeartbeatAt === null ? (
          // NOT "Never": the contract permits a null heartbeat while the node
          // is online, so "never sent a heartbeat" would be a false negative
          // about a machine that is up right now.
          "Not reported"
        ) : (
          <span title={formatEpoch(node.presence.lastHeartbeatAt) ?? undefined}>
            {relativeTime(node.presence.lastHeartbeatAt, nowMs)}
          </span>
        )}
      </DataListItem>
      <DataListItem term="Last connected">
        {/* `lastAuthenticatedAt === null` genuinely does mean never. */}
        {lastConnected ?? "Never"}
      </DataListItem>
      <DataListItem term="Platform">
        {`${platformLabel(node.platformOs)} · ${node.platformArch}`}
      </DataListItem>
      <DataListItem term="Client version" mono>
        {node.clientVersion}
      </DataListItem>
      <DataListItem term="Your role">{roleLabel(node.effectiveRole)}</DataListItem>
      {grantDiffers ? (
        <DataListItem term="Granted role">
          {roleLabel(node.grant.role)}
          <span className="mt-1 block text-muted-foreground">
            The role on your grant differs from the role in effect.
          </span>
        </DataListItem>
      ) : null}
      <DataListItem term="Enrolled">{enrolled ?? "Not reported"}</DataListItem>
      {node.revokedAt !== null ? (
        <DataListItem term="Revoked">
          {`${revoked ?? "Not reported"}${node.revocationReasonCode ? ` — ${node.revocationReasonCode}` : ""}`}
        </DataListItem>
      ) : null}
      <DataListItem
        term="Node ID"
        mono
        action={
          <Button
            size="icon-xs"
            variant="ghost"
            // Icon-only, so the label *is* the accessible name and has to swap
            // with the glyph rather than staying "Copy node ID" after a copy.
            aria-label={isCopied ? "Copied" : "Copy node ID"}
            onClick={() => copyToClipboard(node.id, undefined)}
          >
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          </Button>
        }
      >
        {node.id}
      </DataListItem>
    </DataList>
  );
}

/**
 * The tier-forked node detail sheet — the desktop side panel, the phone bottom
 * sheet — over one shared body. `MobileSheet` applies its own `pb-safe`, so
 * this call site must not repeat it.
 */
export function HostedNodeDetail({
  node,
  directoryStatus,
  browserStatus,
  canRename,
  canRevoke,
  onOpenChange,
  onConnect,
  onRename,
  onRevoke,
}: HostedNodeDetailProps) {
  const isPhoneTier = usePresentationTier() === "phone";
  // The NODE the dialog is open over, never a bare boolean.
  //
  // `node` is re-resolved from the store on every render and goes null the
  // moment its row leaves the directory — another session revoked it, or the
  // grant was removed — and this component then returns null WITHOUT the Sheet
  // primitive ever firing `onOpenChange`. A boolean `revokeOpen` survives that:
  // it is still `true` when the owner opens the next node, and the confirmation
  // remounts already open over a machine they never selected, one click from an
  // irreversible revocation of the wrong one. Derived from the node's own id
  // there is no window at all — a different node cannot inherit it.
  const [renameNodeId, setRenameNodeId] = useState<string | null>(null);
  const [revokeNodeId, setRevokeNodeId] = useState<string | null>(null);
  const open = node !== null;
  if (!node) return null;

  const blocked = nodeSelectionBlocked({ directoryStatus, browserStatus, node });
  const blockedReason = nodeSelectionBlockedReason({ directoryStatus, browserStatus, node });
  const connect = () => {
    onOpenChange(false);
    onConnect(node);
  };
  const reason = blocked && blockedReason ? blockedReason : null;

  if (isPhoneTier) {
    return (
      <MobileSheet open={open} onOpenChange={onOpenChange} label={`Node details: ${node.label}`}>
        <MobileSheetHeader>
          <MobileSheetTitle>{node.label}</MobileSheetTitle>
          <MobileSheetDescription>{nodeMetaLine(node)}</MobileSheetDescription>
        </MobileSheetHeader>
        <MobileSheetPanel>
          <NodeDetailBody node={node} />
          {reason ? <p className="mt-4 text-xs text-muted-foreground">{reason}</p> : null}
        </MobileSheetPanel>
        <MobileSheetFooter>
          <Button className="min-h-11" disabled={blocked} onClick={connect}>
            Connect
          </Button>
        </MobileSheetFooter>
      </MobileSheet>
    );
  }

  // Already revoked is the one state where the action is not offered: the Hub's
  // update is conditioned on the node not already being revoked, so a second
  // attempt is a 404 and nothing else. The sheet itself still opens — that is
  // what it is for — and the `Revoked` row above already says so.
  const revocable = canRevoke && node.revokedAt === null;

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          // A confirmation on top owns the dismissal. `Sheet` and `Dialog` are
          // both `@base-ui/react` dialog roots, and the confirmations are
          // rendered as SIBLINGS of this sheet rather than inside it — so Base
          // UI's topmost check does not relate them, and one Escape reached both
          // roots. The sheet closing takes `detailNodeId` with it, which unmounts
          // the confirmation and everything it was about to report: an Escape
          // during an in-flight revoke lost the Hub's refusal entirely, and the
          // row just stayed, exactly as if the owner had cancelled.
          if (!next && (revokeNodeId !== null || renameNodeId !== null)) return;
          if (!next) {
            setRenameNodeId(null);
            setRevokeNodeId(null);
          }
          onOpenChange(next);
        }}
      >
        <SheetPopup side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="truncate">{node.label}</SheetTitle>
            <SheetDescription>{nodeMetaLine(node)}</SheetDescription>
          </SheetHeader>
          <SheetPanel>
            <NodeDetailBody node={node} />
            {reason ? <p className="mt-4 text-xs text-muted-foreground">{reason}</p> : null}
          </SheetPanel>
          <SheetFooter>
            {/* `sm:mr-auto` puts the irreversible control at the opposite end of
                the footer from the primary one. It is never disabled for a node
                that is merely offline or unreachable: that node is the reason
                this exists, and revocation does not need it to answer. */}
            {revocable ? (
              <Button
                variant="destructive-outline"
                className="sm:mr-auto"
                onClick={() => setRevokeNodeId(node.id)}
              >
                {HOSTED_NODE_REVOKE_ACTION_LABEL}
              </Button>
            ) : null}
            {canRename ? (
              <Button variant="outline" onClick={() => setRenameNodeId(node.id)}>
                Rename
              </Button>
            ) : null}
            <Button disabled={blocked} onClick={connect}>
              Connect
            </Button>
          </SheetFooter>
        </SheetPopup>
      </Sheet>
      {canRename ? (
        <HostedNodeRenameDialog
          node={node}
          open={renameNodeId === node.id}
          onOpenChange={(next) => setRenameNodeId(next ? node.id : null)}
          onRename={(label) => onRename(node, label)}
        />
      ) : null}
      {revocable ? (
        <HostedNodeRevokeDialog
          node={node}
          open={revokeNodeId === node.id}
          onOpenChange={(next) => setRevokeNodeId(next ? node.id : null)}
          onRevoke={() => onRevoke(node)}
        />
      ) : null}
    </>
  );
}
