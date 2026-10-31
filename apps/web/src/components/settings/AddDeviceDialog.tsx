// Only icons the Connections chunk already loads: a new one here regroups the
// shared lucide chunks and grows the app shell (see `scripts/perf/model.ts`).
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { rovingRadioGroup } from "../ui/roving-radio-group";
import { SlidingTabs } from "../ui/sliding-tabs";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type AddDeviceDialogProps,
  type AddDeviceView,
  groupPairingCode,
  observeAccess,
  replaceCode,
  resolveAddDeviceView,
  type ShownCode,
  showCode,
} from "./AddDeviceDialog.logic";
import {
  endpointShareHint,
  isQrShareableEndpoint,
  resolveAdvertisedEndpointPairingUrl,
  selectQrEndpoint,
} from "./ConnectionsSettings.logic";
import { useRelativeTimeTick } from "./settingsLayout";

type DeviceTab = "phone" | "computer";

const DEVICE_TABS = [
  { id: "phone", label: "Phone or tablet" },
  { id: "computer", label: "Computer" },
] as const;

/** T3's share panel: a 168 px code, level M, one module of margin, on a white tile. */
const QR_SIZE_PX = 168;

const CARD_CLASS_NAME = "rounded-2xl border border-border/60 bg-muted/30";

type CopyKind = "link" | "code" | "address";

const COPIED_TITLES: Record<CopyKind, string> = {
  link: "Pairing link copied",
  code: "Pairing code copied",
  address: "Address copied",
};

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/u, "");
}

/**
 * "Add a device": one one-time code per opening, shown as a QR code for a
 * phone and as the code plus this computer's address for another computer.
 * Loaded on the first click (`AddDeviceEntry`).
 */
export function AddDeviceDialog(props: AddDeviceDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-[440px]">
        {/* Each opening mounts its own content, so it mints its own code. */}
        <AddDeviceDialogContent key={props.opening} {...props} />
      </DialogPopup>
    </Dialog>
  );
}

function AddDeviceDialogContent({
  onOpenChange,
  operations,
  pairingLinks,
  clientSessions,
  endpoints,
  defaultEndpointKey,
  onTurnOnNetworkAccess,
}: AddDeviceDialogProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const [tab, setTab] = useState<DeviceTab>("phone");
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [storedShown, setShown] = useState<ShownCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  const [label, setLabel] = useState("");
  const mountedRef = useRef(true);
  const mintedRef = useRef(false);
  const busyRef = useRef(false);

  const shareableEndpoints = useMemo(() => endpoints.filter(isQrShareableEndpoint), [endpoints]);
  const selection = useMemo(
    () => selectQrEndpoint(endpoints, { selectedId: selectedEndpointId, defaultEndpointKey }),
    [defaultEndpointKey, endpoints, selectedEndpointId],
  );
  const reachable = shareableEndpoints.length > 0;

  useEffect(() => {
    mountedRef.current = true;
    // Closing keeps the code: people close this to type it on the other
    // device. It stays listed under Authorized clients until it expires.
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The node's access stream says when the code was listed, redeemed or
  // revoked. Folded in during render (`observeAccess` returns `shown` itself
  // when nothing changed), so a new code also meets a listing it is already in.
  const shown =
    storedShown === null
      ? null
      : observeAccess(storedShown, { pairingLinks, clientSessions, nowMs });
  if (shown !== storedShown) setShown(shown);
  const view = resolveAddDeviceView({ shown, reachable, clientSessions, nowMs });

  const mint = useCallback(
    async (previous: ShownCode | null, nextLabel: string | null) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const result = await replaceCode({
        operations,
        shown: previous,
        nowMs: Date.now(),
        label: nextLabel,
      });
      busyRef.current = false;
      if (!mountedRef.current) return;
      setBusy(false);
      switch (result.kind) {
        case "minted":
          setShown(showCode(result.code));
          return;
        case "revoke-failed":
          // The old code is still live, so it stays on screen.
          setError(errorMessage(result.error, "Could not withdraw the current code."));
          return;
        case "mint-failed":
          setShown(null);
          setError(errorMessage(result.error, "Could not create a pairing code."));
          return;
      }
    },
    [operations],
  );

  // One code per opening, once another device can reach this computer.
  useEffect(() => {
    if (!reachable || mintedRef.current) return;
    mintedRef.current = true;
    void mint(null, null);
  }, [mint, reachable]);

  const { copyToClipboard } = useCopyToClipboard<CopyKind>({
    onCopy: (kind) => toastManager.add({ type: "success", title: COPIED_TITLES[kind] }),
    onError: (cause) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy",
          description: cause.message,
        }),
      ),
  });

  const credential = shown?.code.credential ?? null;
  const qrValue =
    credential !== null && selection?.qrShareable
      ? resolveAdvertisedEndpointPairingUrl(selection.endpoint, credential)
      : null;
  const address = selection ? trimTrailingSlash(selection.endpoint.httpBaseUrl) : null;
  const codeIsShowable =
    view.kind === "code" ||
    view.kind === "expired" ||
    view.kind === "used" ||
    view.kind === "withdrawn";
  const countdown = view.kind === "code" ? view.countdown : null;

  const endpointGroup = rovingRadioGroup({
    options: shareableEndpoints.map((endpoint) => ({ value: endpoint.id })),
    value: selection?.endpoint.id ?? null,
    onChange: setSelectedEndpointId,
  });

  const closeAndTurnOnNetworkAccess = () => {
    if (!onTurnOnNetworkAccess) return;
    onOpenChange(false);
    onTurnOnNetworkAccess();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{dialogTitle(view)}</DialogTitle>
        <DialogDescription>
          {dialogDescription(view, onTurnOnNetworkAccess !== null)}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {view.kind === "unreachable" ? (
          onTurnOnNetworkAccess ? (
            <Button className="w-full" onClick={closeAndTurnOnNetworkAccess}>
              Turn on network access
            </Button>
          ) : null
        ) : null}

        {view.kind === "joined" ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy}
              onClick={() => void mint(shown, null)}
            >
              Add another device
            </Button>
            <Button className="flex-1" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : null}

        {codeIsShowable ? (
          <>
            <SlidingTabs
              aria-label="Device to add"
              tabs={DEVICE_TABS}
              activeId={tab}
              onSelect={(id) => setTab(id === "computer" ? "computer" : "phone")}
            />

            {shareableEndpoints.length >= 2 ? (
              <div
                role="radiogroup"
                aria-label="Reach this computer via"
                className="space-y-1.5"
                onKeyDown={endpointGroup.onKeyDown}
              >
                <p className="text-[11px] text-muted-foreground/70">Reach this computer via</p>
                {shareableEndpoints.map((endpoint) => {
                  const checked = endpoint.id === selection?.endpoint.id;
                  const hint = endpointShareHint(endpoint);
                  return (
                    <button
                      key={endpoint.id}
                      {...endpointGroup.radio(endpoint.id)}
                      className={cn(
                        "flex w-full items-baseline gap-2 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        checked
                          ? "border-foreground/60 bg-muted/30"
                          : "border-border/50 hover:bg-muted/20",
                      )}
                    >
                      <span
                        className={cn(
                          "text-xs font-medium",
                          checked ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {endpoint.label}
                      </span>
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                        {hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div className={cn(CARD_CLASS_NAME, "px-4 pt-4 pb-3")}>
              <div className="relative flex min-h-[200px] items-center justify-center">
                {shown ? (
                  <div
                    className={
                      view.kind === "code"
                        ? "flex w-full justify-center"
                        : "pointer-events-none flex w-full justify-center opacity-10 blur-[2px]"
                    }
                    aria-hidden={view.kind === "code" ? undefined : true}
                  >
                    {tab === "phone" ? (
                      qrValue ? (
                        <div className="w-fit rounded-xl bg-white p-3">
                          <QRCodeSvg
                            value={qrValue}
                            size={QR_SIZE_PX}
                            level="M"
                            marginSize={1}
                            title="Pairing link — scan to open on another device"
                          />
                        </div>
                      ) : (
                        <div className="flex size-[192px] items-center justify-center rounded-xl border border-border/50 p-4">
                          <p className="text-center text-[11px] text-muted-foreground/70">
                            No QR for this endpoint. Another device scanning a loopback link would
                            reach itself.
                          </p>
                        </div>
                      )
                    ) : (
                      <ComputerCode credential={shown.code.credential} address={address} />
                    )}
                  </div>
                ) : error ? (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void mint(null, null)}
                    >
                      Try again
                    </Button>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-4" aria-hidden />
                    Creating a code…
                  </p>
                )}
                {shown && view.kind !== "code" ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center">
                    <p className="text-sm font-semibold text-foreground">{deadCodeTitle(view)}</p>
                    <p className="mb-2 text-xs text-muted-foreground">{deadCodeHint(view)}</p>
                    <Button size="sm" disabled={busy} onClick={() => void mint(shown, null)}>
                      New code
                    </Button>
                  </div>
                ) : null}
              </div>
              {shown && countdown !== null ? (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Expires in {countdown}
                  </span>
                  <span className="flex items-center gap-1">
                    {tab === "phone" && qrValue ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => copyToClipboard(qrValue, "link")}
                      >
                        Copy link
                      </Button>
                    ) : null}
                    {tab === "computer" && address ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => copyToClipboard(address, "address")}
                      >
                        Copy address
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => copyToClipboard(shown.code.credential, "code")}
                    >
                      Copy code
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="New code"
                      title="New code"
                      disabled={busy}
                      onClick={() => void mint(shown, shown.code.label)}
                    >
                      <RefreshCwIcon />
                    </Button>
                  </span>
                </div>
              ) : null}
            </div>

            {shown && countdown !== null ? (
              <p className="text-center text-xs leading-relaxed text-muted-foreground">
                {tab === "phone"
                  ? "Scan it with the Ryco app, or with the camera to open Ryco in the phone's browser."
                  : "On the other computer, open Settings → Connections → Add environment and enter this address and code."}
              </p>
            ) : null}

            {shown && error ? (
              <p role="alert" className="text-center text-xs text-destructive">
                {error}
              </p>
            ) : null}

            <div className="space-y-2">
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={moreOptionsOpen}
                onClick={() => setMoreOptionsOpen((value) => !value)}
              >
                More options
              </Button>
              {moreOptionsOpen ? (
                <div className="flex items-end gap-2">
                  <label className="block min-w-0 flex-1">
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      Device name (optional)
                    </span>
                    <Input
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder="e.g. Living room iPad"
                      disabled={busy}
                    />
                  </label>
                  <Button
                    variant="outline"
                    disabled={busy || label.trim().length === 0}
                    onClick={() => void mint(shown, label.trim())}
                  >
                    New code with this name
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogPanel>
    </>
  );
}

function ComputerCode({ credential, address }: { credential: string; address: string | null }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        Pairing code
      </span>
      <span className="font-mono text-2xl font-semibold tracking-[0.12em] whitespace-pre text-foreground">
        {groupPairingCode(credential).join(" ")}
      </span>
      {address ? (
        <span className="text-xs text-muted-foreground">
          Address <span className="font-mono text-foreground">{address}</span>
        </span>
      ) : null}
    </div>
  );
}

function dialogTitle(view: AddDeviceView): string {
  switch (view.kind) {
    case "unreachable":
      return "Only this computer can reach Ryco now";
    case "joined":
      return `${view.deviceName} is connected`;
    default:
      return "Add a device";
  }
}

function dialogDescription(view: AddDeviceView, canTurnOnNetworkAccess: boolean): string {
  switch (view.kind) {
    case "unreachable":
      return canTurnOnNetworkAccess
        ? "Turn on network access or Tailscale HTTPS so a phone or another computer can reach it."
        : "Pair another device once a network reaches this computer: start Ryco with a non-loopback host, or turn on Tailscale Serve.";
    case "joined":
      return "It is paired as a client and listed under Authorized clients.";
    default:
      return "Pair a phone or another computer as a client. The code works once and expires in a few minutes.";
  }
}

function deadCodeTitle(view: AddDeviceView): string {
  switch (view.kind) {
    case "used":
      return "This code was used";
    case "withdrawn":
      return "This code was withdrawn";
    default:
      return "This code expired";
  }
}

function deadCodeHint(view: AddDeviceView): string {
  switch (view.kind) {
    case "used":
      return "Create a new code to connect another device.";
    case "withdrawn":
      return "It was revoked before a device used it.";
    default:
      return "Create a new code to try again.";
  }
}
