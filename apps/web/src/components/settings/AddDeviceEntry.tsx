import { PlusIcon } from "lucide-react";

import { usePresentationTier } from "../../hooks/usePresentationTier";
import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { AddDeviceDialogProps } from "./AddDeviceDialog.logic";

// The dialog and its view logic load on the first click, not with Connections.
const LazyAddDeviceDialog = preloadableLazy(() =>
  import("./AddDeviceDialog").then((module) => module.AddDeviceDialog),
);

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
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open Add a device",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    },
  });
  return ready && props.opening > 0 ? <LazyAddDeviceDialog {...props} /> : null;
}
