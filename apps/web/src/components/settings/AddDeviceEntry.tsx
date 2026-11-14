import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { isHostedHubMode } from "../../env";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { AddDeviceDialogProps } from "./AddDeviceDialog.logic";
import { useLocalSessionAccess } from "./localSessionAccess";
import { errorMessage } from "~/lib/errorMessage";

// The dialog and its view logic load on the first click, not with Connections.
const LazyAddDeviceDialog = preloadableLazy(() =>
  import("./AddDeviceDialog").then((module) => module.AddDeviceDialog),
);
// All devices' flow: this computer's access state with the dialog, on the first click.
const LazyAddDeviceFlow = preloadableLazy(() =>
  import("./ConnectionsSettings").then((module) => module.AddDeviceFlow),
);

function reportLoadError(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not open Add a device",
      description: errorMessage(error, "Try again."),
    }),
  );
}

/**
 * "Add a device", for owners. Hidden on the phone tier: the native app is the
 * phone experience, and the frozen web phone tier gains nothing new.
 */
export function AddDeviceButton({ onClick }: { readonly onClick: () => void }) {
  const tier = usePresentationTier();
  if (tier === "phone") return null;
  return (
    <Button size="xs" variant="default" onClick={onClick}>
      <PlusIcon className="size-3" />
      Add a device
    </Button>
  );
}

/**
 * Mounts the dialog once it was first opened (`opening` > 0) and its chunk is
 * in, so it never shows a loading fallback. A failed load closes it again; the
 * next click retries.
 */
export function AddDeviceDialogHost(props: AddDeviceDialogProps) {
  const ready = useLazyComponentReady(LazyAddDeviceDialog, props.open, {
    onLoadError: (error) => {
      props.onOpenChange(false);
      reportLoadError(error);
    },
  });
  return ready && props.opening > 0 ? <LazyAddDeviceDialog {...props} /> : null;
}

/**
 * All devices' "Add a device" card: pairs another device with this computer
 * through the same dialog as Access. Only this computer's owner sees it, never
 * in hosted mode (a hosted browser runs no backend of its own) or on the phone
 * tier. Nothing about this computer's access loads until the first click.
 */
export function AddDeviceCard({ className }: { readonly className?: string }) {
  const tier = usePresentationTier();
  const { role } = useLocalSessionAccess();
  const [opening, setOpening] = useState(0);
  const [wanted, setWanted] = useState(false);
  const ready = useLazyComponentReady(LazyAddDeviceFlow, wanted, {
    onLoadError: (error) => {
      setWanted(false);
      reportLoadError(error);
    },
  });
  if (isHostedHubMode() || tier === "phone" || role !== "owner") return null;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setWanted(true);
          setOpening((current) => current + 1);
        }}
        onPointerEnter={() => void LazyAddDeviceFlow.preload()}
        onFocus={() => void LazyAddDeviceFlow.preload()}
        className={className}
      >
        <PlusIcon aria-hidden className="size-4" />
        <span className="text-[13px] font-medium text-foreground">Add a device</span>
        <span className="text-xs text-muted-foreground">Pair a phone, browser or computer</span>
      </button>
      {ready && opening > 0 ? <LazyAddDeviceFlow opening={opening} /> : null}
    </>
  );
}
