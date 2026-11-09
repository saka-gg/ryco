import type { AuthAccessList } from "@ryco/client-runtime/machineAccess/authAccess";
import {
  groupPairingCode,
  observeAccess,
  replaceCode,
  resolveAddDeviceView,
  showCode,
  type AddDeviceOperations,
  type ShownCode,
} from "@ryco/client-runtime/machineAccess/addDeviceCode";
import { isQrShareableEndpoint } from "@ryco/client-runtime/machineAccess/advertisedEndpoints";
import type { AdvertisedEndpoint } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  TextInput,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useThemeColor } from "../../lib/useThemeColor";
import { ActionChip } from "./MachineAccessParts";
import { PairingQrCode } from "./PairingQrCode";
import {
  addDeviceDescription,
  addDeviceTitle,
  deadCodeHint,
  deadCodeTitle,
  derivePairingShare,
} from "./machineAccessModel";
import { useNowMs } from "./useMachineAccess";

type DeviceTab = "phone" | "computer";

const DEVICE_TABS: ReadonlyArray<{ readonly id: DeviceTab; readonly label: string }> = [
  { id: "phone", label: "Phone or tablet" },
  { id: "computer", label: "Computer" },
];

/** Opens the iOS share sheet with the link, so it can go out by Messages, AirDrop or Mail. */
export function sharePairingLink(url: string): void {
  void Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch(() => undefined);
}

function mintErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * "New code", and the opening's first code: withdraw the live code on screen,
 * then mint the next (`replaceCode`). A plain function so the sheet's effect
 * and its buttons share it without the effect depending on a render-local.
 */
async function mintCode(input: {
  readonly operations: AddDeviceOperations;
  readonly previous: ShownCode | null;
  readonly label: string | null;
  readonly busyRef: { current: boolean };
  readonly mountedRef: { current: boolean };
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: string | null) => void;
  readonly setShown: (shown: ShownCode | null) => void;
}): Promise<void> {
  if (input.busyRef.current) return;
  input.busyRef.current = true;
  input.setBusy(true);
  input.setError(null);
  const result = await replaceCode({
    operations: input.operations,
    shown: input.previous,
    nowMs: Date.now(),
    label: input.label,
  });
  input.busyRef.current = false;
  if (!input.mountedRef.current) return;
  input.setBusy(false);
  switch (result.kind) {
    case "minted":
      input.setShown(showCode(result.code));
      return;
    case "revoke-failed":
      // The old code is still live, so it stays on screen.
      input.setError(mintErrorMessage(result.error, "Could not withdraw the current code."));
      return;
    case "mint-failed":
      input.setShown(null);
      input.setError(mintErrorMessage(result.error, "Could not create a pairing code."));
      return;
  }
}

export interface AddDeviceSheetProps {
  readonly machineLabel: string;
  readonly operations: AddDeviceOperations;
  /** From the screen's own access subscription: the sheet opens none. */
  readonly access: AuthAccessList;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly onClose: () => void;
}

/**
 * "Add a device" for a machine this phone owns: one client-role, one-time code
 * per opening, as a QR code and link for a phone and as the code plus address
 * for a computer. Closing keeps the code: it stays listed under Pairing links,
 * revocable, until it is used or expires. Mount it once per opening.
 */
export function AddDeviceSheet(props: AddDeviceSheetProps) {
  const nowMs = useNowMs();
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const [tab, setTab] = useState<DeviceTab>("phone");
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [storedShown, setShown] = useState<ShownCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const mountedRef = useRef(true);
  const mintedRef = useRef(false);
  const busyRef = useRef(false);

  const reachable = props.endpoints.some(isQrShareableEndpoint);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Folded in during render (`observeAccess` returns `shown` itself when
  // nothing changed): the node's stream says when the code was listed,
  // redeemed or revoked.
  const shown =
    storedShown === null
      ? null
      : observeAccess(storedShown, {
          pairingLinks: props.access.pairingLinks,
          clientSessions: props.access.clientSessions,
          nowMs,
        });
  if (shown !== storedShown) setShown(shown);
  const view = resolveAddDeviceView({
    shown,
    reachable,
    clientSessions: props.access.clientSessions,
    nowMs,
  });
  const credential = shown === null ? null : shown.code.credential;
  const share = derivePairingShare({ endpoints: props.endpoints, selectedEndpointId, credential });

  const mint = (previous: ShownCode | null, nextLabel: string | null) =>
    mintCode({
      operations: props.operations,
      previous,
      label: nextLabel,
      busyRef,
      mountedRef,
      setBusy,
      setError,
      setShown,
    });

  // One code per opening, once another device can reach the machine.
  const { operations } = props;
  useEffect(() => {
    if (!reachable || mintedRef.current) return;
    mintedRef.current = true;
    void mintCode({
      operations,
      previous: null,
      label: null,
      busyRef,
      mountedRef,
      setBusy,
      setError,
      setShown,
    });
  }, [operations, reachable]);

  const codeIsShowable =
    view.kind === "code" ||
    view.kind === "expired" ||
    view.kind === "used" ||
    view.kind === "withdrawn";
  const countdown = view.kind === "code" ? view.countdown : null;
  const shownLabel = shown === null ? null : shown.code.label;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View className="flex-1 bg-screen">
          <View className="flex-row items-center gap-3 px-5 pt-5 pb-2">
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-ryco-bold text-foreground" numberOfLines={2}>
                {addDeviceTitle(view, props.machineLabel)}
              </Text>
              <Text className="font-sans text-sm text-foreground-muted">
                On {props.machineLabel}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close add a device"
              onPress={props.onClose}
              className="h-11 min-w-16 items-center justify-center rounded-full active:bg-subtle"
            >
              <Text className="text-base font-ryco-medium text-foreground">Done</Text>
            </Pressable>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: 8,
              paddingBottom: 40,
              gap: 16,
            }}
          >
            <Text className="font-sans text-sm leading-relaxed text-foreground-muted">
              {addDeviceDescription(view, props.machineLabel)}
            </Text>

            {view.kind === "joined" ? (
              <View className="flex-row gap-2">
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void mint(shown, null)}
                  className="h-12 flex-1 items-center justify-center rounded-full border border-border active:bg-subtle disabled:opacity-40"
                >
                  <Text className="text-base font-ryco-medium text-foreground">
                    Add another device
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={props.onClose}
                  className="h-12 flex-1 items-center justify-center rounded-full bg-primary active:opacity-80"
                >
                  <Text className="text-base font-ryco-bold text-primary-foreground">Done</Text>
                </Pressable>
              </View>
            ) : null}

            {codeIsShowable ? (
              <>
                <View className="flex-row rounded-full border border-border bg-card p-1">
                  {DEVICE_TABS.map((entry) => (
                    <Pressable
                      key={entry.id}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: tab === entry.id }}
                      onPress={() => setTab(entry.id)}
                      className={cn(
                        "h-9 flex-1 items-center justify-center rounded-full",
                        tab === entry.id && "bg-subtle",
                      )}
                    >
                      <Text
                        className={cn(
                          "text-sm font-ryco-medium",
                          tab === entry.id ? "text-foreground" : "text-foreground-muted",
                        )}
                      >
                        {entry.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {share.choices.length > 0 ? (
                  <View accessibilityRole="radiogroup" className="gap-1.5">
                    <Text className="text-xs font-ryco-medium text-foreground-muted">
                      Reach {props.machineLabel} via
                    </Text>
                    {share.choices.map((choice) => {
                      const checked = choice.id === share.selectedEndpointId;
                      return (
                        <Pressable
                          key={choice.id}
                          accessibilityRole="radio"
                          accessibilityState={{ checked }}
                          onPress={() => setSelectedEndpointId(choice.id)}
                          className={cn(
                            "flex-row items-baseline gap-2 rounded-xl border px-3 py-2.5 active:bg-subtle",
                            checked ? "border-foreground-muted bg-card" : "border-border",
                          )}
                        >
                          <Text
                            className={cn(
                              "text-sm font-ryco-medium",
                              checked ? "text-foreground" : "text-foreground-muted",
                            )}
                          >
                            {choice.label}
                          </Text>
                          <Text
                            className="min-w-0 flex-1 text-xs text-foreground-tertiary"
                            numberOfLines={1}
                          >
                            {choice.hint}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}

                <CodeCard
                  tab={tab}
                  shown={shown}
                  qrUrl={share.qrUrl}
                  address={share.address}
                  live={view.kind === "code"}
                  deadTitle={view.kind === "code" ? null : deadCodeTitle(view)}
                  deadHint={view.kind === "code" ? null : deadCodeHint(view)}
                  error={shown === null ? error : null}
                  busy={busy}
                  onNewCode={() => void mint(shown, shownLabel)}
                  onRetry={() => void mint(null, null)}
                />

                {shown !== null && countdown !== null ? (
                  <View className="gap-3">
                    <Text className="text-center text-xs text-foreground-muted">
                      Expires in {countdown}
                    </Text>
                    <View className="flex-row flex-wrap justify-center gap-2">
                      {tab === "phone" && share.url !== null ? (
                        <>
                          <ActionChip
                            label="Share link"
                            onPress={() => sharePairingLink(share.url ?? "")}
                          />
                          <ActionChip
                            label="Copy link"
                            onPress={() => copyTextWithHaptic(share.url ?? "")}
                          />
                        </>
                      ) : null}
                      {tab === "computer" && share.address !== null ? (
                        <ActionChip
                          label="Copy address"
                          onPress={() => copyTextWithHaptic(share.address ?? "")}
                        />
                      ) : null}
                      <ActionChip
                        label="Copy code"
                        onPress={() => copyTextWithHaptic(shown.code.credential)}
                      />
                      <ActionChip
                        label="New code"
                        busy={busy}
                        disabled={busy}
                        onPress={() => void mint(shown, shownLabel)}
                      />
                    </View>
                    <Text className="text-center font-sans text-xs leading-relaxed text-foreground-muted">
                      {tab === "phone"
                        ? "Scan it with the Ryco app, or with the camera to open Ryco in the phone's browser."
                        : "On the other computer, open Settings → Connections → Add environment and enter this address and code."}
                    </Text>
                  </View>
                ) : null}

                {shown !== null && error !== null ? <ErrorBanner message={error} /> : null}

                <View className="gap-2">
                  <Text className="text-xs font-ryco-medium text-foreground-muted">
                    Device name (optional)
                  </Text>
                  <TextInput
                    accessibilityLabel="Device name"
                    value={label}
                    onChangeText={setLabel}
                    editable={!busy}
                    placeholder="e.g. Living room iPad"
                    placeholderTextColor={placeholderColor as string}
                    style={{ color: textColor as string }}
                    className="min-h-12 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
                    returnKeyType="done"
                  />
                  <ActionChip
                    label="New code with this name"
                    disabled={busy || label.trim().length === 0}
                    onPress={() => void mint(shown, label.trim())}
                  />
                </View>
              </>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CodeCard(props: {
  readonly tab: DeviceTab;
  readonly shown: ShownCode | null;
  readonly qrUrl: string | null;
  readonly address: string | null;
  readonly live: boolean;
  readonly deadTitle: string | null;
  readonly deadHint: string | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly onNewCode: () => void;
  readonly onRetry: () => void;
}) {
  const spinner = useThemeColor("--color-icon-muted");
  return (
    <View className="min-h-64 items-center justify-center rounded-2xl border border-border bg-card px-4 py-5">
      {props.shown !== null ? (
        <View
          className={cn("w-full items-center", !props.live && "opacity-10")}
          accessibilityElementsHidden={!props.live}
          importantForAccessibility={props.live ? "auto" : "no-hide-descendants"}
        >
          {props.tab === "phone" ? (
            props.qrUrl !== null ? (
              <PairingQrCode value={props.qrUrl} />
            ) : (
              <Text className="max-w-60 text-center text-xs text-foreground-muted">
                No QR for this address. Another device scanning a loopback link would reach itself.
              </Text>
            )
          ) : (
            <View className="items-center gap-3">
              <Text className="text-2xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
                Pairing code
              </Text>
              <Text className="font-mono text-2xl text-foreground" selectable>
                {groupPairingCode(props.shown.code.credential).join(" ")}
              </Text>
              {props.address !== null ? (
                <Text className="text-xs text-foreground-muted" selectable>
                  Address <Text className="font-mono text-foreground">{props.address}</Text>
                </Text>
              ) : null}
            </View>
          )}
        </View>
      ) : props.error !== null ? (
        <View className="items-center gap-3">
          <Text className="text-center text-sm text-danger-foreground">{props.error}</Text>
          <ActionChip label="Try again" disabled={props.busy} onPress={props.onRetry} />
        </View>
      ) : (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color={spinner as string} />
          <Text className="text-sm text-foreground-muted">Creating a code…</Text>
        </View>
      )}
      {props.shown !== null && !props.live && props.deadTitle !== null ? (
        <View className="absolute inset-0 items-center justify-center gap-1.5 px-6">
          <Text className="text-center text-base font-ryco-bold text-foreground">
            {props.deadTitle}
          </Text>
          <Text className="mb-2 text-center text-xs text-foreground-muted">{props.deadHint}</Text>
          <ActionChip label="New code" disabled={props.busy} onPress={props.onNewCode} />
        </View>
      ) : null}
    </View>
  );
}
