import { DownloadIcon, RefreshCwIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  hostedPwaLifecycle,
  type HostedPwaLifecycle,
  type HostedPwaSnapshot,
} from "../../pwa/lifecycle";
import { useHostedPwaSnapshot } from "../../pwa/useHostedPwaSnapshot";
import { HostedRelayTrustNotice } from "./HostedRelayTrustNotice";

/**
 * - `default`: outline buttons in the page's own flow (node directory, account).
 * - `compact`: the same, sized for the connection menu.
 * - `subtle`: one muted text-weight row for the signed-out gateway, where
 *   installing is an aside to signing in and must not compete with it. The
 *   gateway draws the relay trust notice beside this row already, so the
 *   install instructions do not repeat it here.
 */
export type HostedPwaControlsVariant = "default" | "compact" | "subtle";

export function HostedPwaControls({
  variant = "default",
  lifecycle = hostedPwaLifecycle,
}: {
  readonly variant?: HostedPwaControlsVariant;
  readonly lifecycle?: HostedPwaLifecycle | null;
}) {
  return lifecycle ? <ConnectedHostedPwaControls variant={variant} lifecycle={lifecycle} /> : null;
}

function ConnectedHostedPwaControls({
  variant,
  lifecycle,
}: {
  readonly variant: HostedPwaControlsVariant;
  readonly lifecycle: HostedPwaLifecycle;
}) {
  const snapshot = useHostedPwaSnapshot(lifecycle);
  const compact = variant === "compact";
  const [showInstructions, setShowInstructions] = useState(false);
  const installAvailable =
    snapshot.installState === "native-available" || snapshot.installState === "manual-available";

  if (
    !installAvailable &&
    snapshot.updateState === "idle" &&
    snapshot.registrationState !== "unavailable"
  ) {
    return null;
  }

  if (variant === "subtle") {
    const subtleClassName =
      "inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 phone:min-h-11 [&_svg]:size-3.5 [&_svg]:shrink-0";
    return (
      // `contents` for the same reason as the trust notice's disclosure row:
      // the buttons sit in the page's aside row, and anything expanded drops
      // to its own full-width line beneath it.
      <section className="contents" aria-label="Ryco app installation">
        <>
          {snapshot.installState === "native-available" ? (
            <button
              type="button"
              className={subtleClassName}
              onClick={() => void lifecycle.promptInstall()}
            >
              <DownloadIcon aria-hidden /> Install app
            </button>
          ) : null}
          {snapshot.installState === "manual-available" ? (
            <button
              type="button"
              className={subtleClassName}
              aria-expanded={showInstructions}
              onClick={() => setShowInstructions((visible) => !visible)}
            >
              <DownloadIcon aria-hidden /> Install app
            </button>
          ) : null}
          {snapshot.updateState !== "idle" ? (
            <button
              type="button"
              className={subtleClassName}
              disabled={snapshot.updateState === "activating"}
              onClick={() => lifecycle.activateUpdate()}
            >
              <RefreshCwIcon aria-hidden />
              {snapshot.updateState === "activating" ? "Updating…" : "Update ready"}
            </button>
          ) : null}
        </>
        {showInstructions ? (
          <div className="order-last mt-2 basis-full">
            <InstallInstructions
              snapshot={snapshot}
              showTrustNotice={false}
              onClose={() => setShowInstructions(false)}
            />
          </div>
        ) : null}
        {snapshot.registrationState === "unavailable" && snapshot.errorMessage ? (
          <p
            role="status"
            className="order-last mt-1 basis-full text-center text-muted-foreground text-xs"
          >
            {snapshot.errorMessage}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={compact ? "space-y-2" : "mt-4 space-y-3"}
      aria-label="Ryco app installation"
    >
      <div className="flex flex-wrap gap-2">
        {snapshot.installState === "native-available" ? (
          <Button
            className="min-h-11"
            size={compact ? "sm" : "default"}
            variant="outline"
            onClick={() => void lifecycle.promptInstall()}
          >
            <DownloadIcon aria-hidden /> Install Ryco
          </Button>
        ) : null}
        {snapshot.installState === "manual-available" ? (
          <Button
            className="min-h-11"
            size={compact ? "sm" : "default"}
            variant="outline"
            aria-expanded={showInstructions}
            onClick={() => setShowInstructions((visible) => !visible)}
          >
            <SmartphoneIcon aria-hidden /> How to install
          </Button>
        ) : null}
        {snapshot.updateState !== "idle" ? (
          <Button
            className="min-h-11"
            size={compact ? "sm" : "default"}
            variant="outline"
            disabled={snapshot.updateState === "activating"}
            onClick={() => lifecycle.activateUpdate()}
          >
            <RefreshCwIcon aria-hidden />
            {snapshot.updateState === "activating" ? "Updating…" : "Update ready"}
          </Button>
        ) : null}
      </div>
      {showInstructions ? (
        <InstallInstructions snapshot={snapshot} onClose={() => setShowInstructions(false)} />
      ) : null}
      {snapshot.registrationState === "unavailable" && snapshot.errorMessage ? (
        <p role="status" className="text-xs text-muted-foreground">
          {snapshot.errorMessage}
        </p>
      ) : null}
    </section>
  );
}

function InstallInstructions({
  snapshot,
  onClose,
  showTrustNotice = true,
}: {
  readonly snapshot: HostedPwaSnapshot;
  readonly onClose: () => void;
  readonly showTrustNotice?: boolean;
}) {
  return (
    <div
      role="region"
      aria-label="Install Ryco instructions"
      className="rounded-lg border border-border bg-background p-3 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">Install Ryco on this device</p>
          {snapshot.platform === "ios" ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              In Safari, open the Share or browser menu, choose Add to Home Screen, enable Open as
              Web App when offered, then tap Add.
            </p>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Open the browser menu, choose Add to home screen or Install app, then confirm Install.
            </p>
          )}
        </div>
        <Button className="size-11 shrink-0" size="icon" variant="ghost" onClick={onClose}>
          <XIcon aria-hidden /> <span className="sr-only">Close install instructions</span>
        </Button>
      </div>
      {showTrustNotice ? (
        <div className="mt-3 border-t border-border pt-3">
          <HostedRelayTrustNotice variant="inline" />
        </div>
      ) : null}
    </div>
  );
}
