import {
  CHANGELOG_PAGE_URL,
  CHANGELOG_RELEASES,
  type ChangelogRelease,
} from "@ryco/shared/releaseNotes";
import { selectReleasesBetween } from "@ryco/shared/releaseVersion";
import { useRef, useState } from "react";

import { APP_BASE_NAME, APP_VERSION } from "../../branding";
import { openExternalLink } from "../../lib/openExternalLink";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { closeWhatsNewDialog, useWhatsNewDialogStore } from "./whatsNewDialogStore";

/** Browsing shows this many releases before "Show earlier releases". */
const INITIAL_RELEASE_COUNT = 3;

/**
 * The releases the dialog lists, newest first: those since `sinceVersion`
 * after an update, otherwise every release up to the running one. A build
 * without a release version (development) lists them all.
 */
export function releasesForWhatsNew(
  releases: ReadonlyArray<ChangelogRelease>,
  input: { readonly currentVersion: string; readonly sinceVersion: string | null },
): ChangelogRelease[] {
  const selected = selectReleasesBetween(releases, input);
  if (selected.length > 0 || input.sinceVersion !== null) return selected;
  return [...releases];
}

function describeReleases(
  releases: ReadonlyArray<ChangelogRelease>,
  sinceVersion: string | null,
): string {
  const latest = releases[0];
  if (!latest) return "No release notes for this version yet.";
  if (sinceVersion !== null && releases.length > 1) {
    return `${releases.length} releases since ${sinceVersion}, the version you used last.`;
  }
  return `${APP_BASE_NAME} ${latest.version} · ${latest.date}`;
}

/** The release notes of this version of Ryco, or of the releases since the last one seen. */
export function WhatsNewDialog() {
  const open = useWhatsNewDialogStore((state) => state.open);
  const sinceVersion = useWhatsNewDialogStore((state) => state.sinceVersion);
  const [showAll, setShowAll] = useState(false);
  // Focus starts on Done, so Enter or Escape closes and no link opens a ring.
  const doneRef = useRef<HTMLButtonElement>(null);
  const releases = releasesForWhatsNew(CHANGELOG_RELEASES, {
    currentVersion: APP_VERSION,
    sinceVersion,
  });
  // After an update every new release shows; browsing starts with the latest few.
  const visible =
    sinceVersion !== null || showAll ? releases : releases.slice(0, INITIAL_RELEASE_COUNT);
  const hidden = releases.length - visible.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        closeWhatsNewDialog();
        setShowAll(false);
      }}
    >
      <DialogPopup className="sm:max-w-xl" data-testid="whats-new-dialog" initialFocus={doneRef}>
        <DialogHeader>
          <DialogTitle>What's new</DialogTitle>
          <DialogDescription>{describeReleases(releases, sinceVersion)}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-7">
            {visible.map((release) => (
              <ReleaseNotes
                key={release.version}
                release={release}
                showHeading={releases.length > 1}
              />
            ))}
            {hidden > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setShowAll(true)}
              >
                Show {hidden} earlier {hidden === 1 ? "release" : "releases"}
              </Button>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => openExternalLink(CHANGELOG_PAGE_URL, "Could not open the changelog")}
          >
            All release notes
          </Button>
          <Button ref={doneRef} onClick={closeWhatsNewDialog}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ReleaseNotes({
  release,
  showHeading,
}: {
  readonly release: ChangelogRelease;
  readonly showHeading: boolean;
}) {
  return (
    <section aria-label={`Version ${release.version}`} className="flex flex-col gap-3">
      {showHeading ? (
        <div className="flex items-baseline gap-2">
          <h3 className="font-mono text-sm font-semibold text-foreground">{release.version}</h3>
          <time dateTime={release.dateTime} className="text-xs text-muted-foreground">
            {release.date}
          </time>
        </div>
      ) : null}
      <p className="text-sm text-foreground">{release.summary}</p>
      <ul className="flex flex-col gap-2.5">
        {release.highlights.map((highlight) => (
          <li key={highlight.title} className="text-sm">
            <span className="font-medium text-foreground">{highlight.title}.</span>{" "}
            <span className="text-muted-foreground">{highlight.summary}</span>
          </li>
        ))}
      </ul>
      <Button
        variant="link"
        size="xs"
        className="h-auto self-start px-0 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => openExternalLink(release.releaseUrl, "Could not open the release")}
      >
        Full release on GitHub
      </Button>
    </section>
  );
}
