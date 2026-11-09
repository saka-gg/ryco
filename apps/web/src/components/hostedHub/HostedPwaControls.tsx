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

export function HostedPwaControls({
  compact = false,
  lifecycle = hostedPwaLifecycle,
}: {
  readonly compact?: boolean;
  readonly lifecycle?: HostedPwaLifecycle | null;
}) {
  return lifecycle ? <ConnectedHostedPwaControls compact={compact} lifecycle={lifecycle} /> : null;
}

function ConnectedHostedPwaControls({
  compact,
  lifecycle,
}: {
  readonly compact: boolean;
  readonly lifecycle: HostedPwaLifecycle;
}) {
  const snapshot = useHostedPwaSnapshot(lifecycle);
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
}: {
  readonly snapshot: HostedPwaSnapshot;
  readonly onClose: () => void;
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
      <div className="mt-3 border-t border-border pt-3">
        <HostedRelayTrustNotice compact />
      </div>
    </div>
  );
}
