import type { OverviewChanges } from "../../overviewTypes";
import { AheadBehind } from "../../overviewSections";
import {
  CrownDetailEmpty,
  CrownDetailFootnote,
  CrownDetailHeading,
  CrownKeyValueRow,
  type CrownDetailViewProps,
} from "./crownDetailPrimitives";

/** The heading's `↑2 ↓1` / "in sync" meta (the lab's `.abx`), shared with the Ship preview. */
export function SyncMeta({ changes }: { changes: OverviewChanges }) {
  const parts = [
    changes.aheadCount > 0 ? `↑${changes.aheadCount}` : null,
    changes.behindCount > 0 ? `↓${changes.behindCount}` : null,
  ].filter(Boolean);
  return (
    <span className="text-[10.5px] font-semibold text-info-foreground">
      {parts.length > 0 ? parts.join(" ") : "in sync"}
    </span>
  );
}

/** Sync and upstream rows, shared by the preview and the card. */
function BranchSyncRows({ changes }: { changes: OverviewChanges }) {
  return (
    <>
      <CrownKeyValueRow label="Sync">
        {changes.aheadCount > 0 || changes.behindCount > 0 ? (
          <AheadBehind ahead={changes.aheadCount} behind={changes.behindCount} />
        ) : (
          <span className="text-muted-foreground">In sync</span>
        )}
      </CrownKeyValueRow>
      {changes.hasUpstream !== undefined ? (
        <CrownKeyValueRow label="Upstream">
          {changes.hasUpstream ? (
            "Tracking origin"
          ) : (
            <span className="text-muted-foreground">Not pushed yet</span>
          )}
        </CrownKeyValueRow>
      ) : null}
    </>
  );
}

/**
 * The branch summary for a hover preview without a Ship button (no checkout
 * to act on yet). The branch picker and the git controls stay in the card: a
 * combobox or menu opened inside a hover preview would close under the pointer.
 */
function BranchPreview({ changes }: { changes: OverviewChanges | undefined }) {
  return (
    <>
      <CrownDetailHeading
        section="branch"
        variant="flyout"
        meta={changes ? <SyncMeta changes={changes} /> : null}
      />
      {changes ? (
        <>
          {changes.refName ? (
            <CrownKeyValueRow label="Branch" className="font-mono text-[11.5px]">
              {changes.refName}
            </CrownKeyValueRow>
          ) : null}
          <BranchSyncRows changes={changes} />
          <CrownDetailFootnote>Click to open the branch</CrownDetailFootnote>
        </>
      ) : (
        <CrownDetailEmpty>No branch details yet</CrownDetailEmpty>
      )}
    </>
  );
}

export function BranchDetail({ layout, variant }: CrownDetailViewProps) {
  const { changes, branchControl, sourceControlActions } = layout;
  if (variant === "flyout") {
    return <BranchPreview changes={changes} />;
  }
  const hasContent = Boolean(branchControl || sourceControlActions || changes);
  return (
    <>
      {/* Pre-rendered branch picker (`panelRow`); it owns its 36px height. */}
      {branchControl ? <div className="mb-1 w-full min-w-0">{branchControl}</div> : null}
      {changes ? <BranchSyncRows changes={changes} /> : null}
      {/* Pre-rendered commit / push / PR controls; `onPostPush` stays wired upstream. */}
      {sourceControlActions ? (
        <div className="mt-2.5 w-full min-w-0">{sourceControlActions}</div>
      ) : null}
      {hasContent ? null : <CrownDetailEmpty>No branch details yet</CrownDetailEmpty>}
    </>
  );
}
