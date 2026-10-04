import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useThemeColor } from "../../lib/useThemeColor";
import { DirectConnectionMethods } from "../nodes/DirectConnectionMethods";
import {
  canSubmitDirectConnection,
  directRepairPrefill,
  type DirectConnectionMode,
} from "../nodes/directConnectionMethodsModel";
import { extractPairingUrlFromQrPayload } from "./pairing";
import { useConnectionActions, useSavedEnvironments } from "./useConnectionController";

type ConnectionsNewRouteScreenProps = StaticScreenProps<
  | {
      /**
       * A saved machine to pair again. Only an id is taken, never an address:
       * the host comes from this device's own saved record, so a link cannot
       * point the pairing code somewhere else.
       */
      readonly repairEnvironmentId?: string;
    }
  | undefined
>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// B2 pairing surface — replaces B1's PairingScreen. QR scan (expo-camera) folds
// the scanned payload into the URL field; URL and host+code both pair through the
// tested environmentActions.addSavedEnvironment. Direct-node only.
export function ConnectionsNewRouteScreen(props: ConnectionsNewRouteScreenProps) {
  const navigation = useNavigation();
  const actions = useConnectionActions();
  const { rows } = useSavedEnvironments();
  const repairEnvironmentId = firstParam(props.route.params?.repairEnvironmentId);
  const repairRecord =
    repairEnvironmentId === null
      ? null
      : (rows.find((row) => row.record.environmentId === repairEnvironmentId)?.record ?? null);
  const [repairPrefill] = useState(() =>
    repairRecord ? directRepairPrefill(repairRecord.httpBaseUrl) : null,
  );
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<DirectConnectionMode>(repairPrefill?.mode ?? "url");
  const [scanning, setScanning] = useState(false);
  const [pairingUrl, setPairingUrl] = useState("");
  const [host, setHost] = useState(repairPrefill?.host ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");

  const onScan = useCallback((payload: string) => {
    setScanning(false);
    try {
      setPairingUrl(extractPairingUrlFromQrPayload(payload));
      setMode("url");
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Could not read the QR code.");
    }
  }, []);

  const openScanner = useCallback(async () => {
    setError(null);
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setError("Camera permission is needed to scan a pairing QR code.");
        return;
      }
    }
    setScanning(true);
  }, [permission, requestPermission]);

  const pair = useCallback(async () => {
    setError(null);
    setPairing(true);
    try {
      await actions.addSavedEnvironment(
        mode === "url"
          ? { label: "", pairingUrl: pairingUrl.trim() }
          : { label: "", host: host.trim(), pairingCode: code.trim() },
      );
      navigation.goBack();
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : "Pairing failed.");
    } finally {
      setPairing(false);
    }
  }, [actions, mode, pairingUrl, host, code, navigation]);

  const canPair =
    !pairing &&
    canSubmitDirectConnection({
      mode,
      pairingUrl,
      host,
      code,
    });

  const inputStyle = { color: textColor as string };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, paddingBottom: 44, gap: 18 }}
    >
      <Text className="font-sans text-base leading-normal text-foreground-muted">
        {repairRecord
          ? `${repairRecord.label} no longer accepts this device's saved pairing. Enter a new pairing code from the machine to pair it again.`
          : "Pair this device straight to one of your machines. Direct credentials stay separate from your Hub account."}
      </Text>
      {error ? <ErrorBanner message={error} /> : null}

      {scanning ? (
        <View className="overflow-hidden rounded-2xl border border-border" style={{ height: 260 }}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(result) => onScan(result.data)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel QR scan"
            onPress={() => setScanning(false)}
            className="absolute bottom-3 h-11 self-center justify-center rounded-full bg-primary px-4 active:opacity-70"
          >
            <Text className="text-sm font-ryco-bold text-primary-foreground">Cancel scan</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scan pairing QR code"
          onPress={() => void openScanner()}
          className="min-h-16 flex-row items-center rounded-2xl border border-border bg-card px-4 py-3 active:bg-card-alt"
        >
          <View className="min-w-0 flex-1">
            <Text className="text-base font-ryco-bold text-foreground">Scan QR code</Text>
            <Text className="mt-0.5 text-xs font-ryco-medium text-foreground-muted">
              Fastest — scan the code shown by Ryco Desktop.
            </Text>
          </View>
        </Pressable>
      )}

      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-tertiary">
          Or enter details
        </Text>
        <View className="h-px flex-1 bg-border" />
      </View>

      <DirectConnectionMethods value={mode} disabled={pairing} onChange={setMode} />

      {mode === "url" ? (
        <View className="gap-2">
          <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Pairing URL</Text>
          <TextInput
            accessibilityLabel="Pairing URL"
            value={pairingUrl}
            onChangeText={setPairingUrl}
            placeholder="ryco://pair?host=…#token=…"
            placeholderTextColor={placeholderColor as string}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-sm"
            style={inputStyle}
          />
        </View>
      ) : (
        <View className="gap-3">
          <View className="gap-2">
            <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
              {mode === "tailscale" ? "Tailscale host" : "LAN host"}
            </Text>
            <TextInput
              accessibilityLabel={mode === "tailscale" ? "Tailscale host" : "LAN host"}
              value={host}
              onChangeText={setHost}
              placeholder={
                mode === "tailscale" ? "studio.example.ts.net:44342" : "macbook.local:44342"
              }
              placeholderTextColor={placeholderColor as string}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-sm"
              style={inputStyle}
            />
          </View>
          <View className="gap-2">
            <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
              Pairing code
            </Text>
            <TextInput
              accessibilityLabel="Pairing code"
              value={code}
              onChangeText={setCode}
              placeholder="Code shown by Ryco Desktop"
              placeholderTextColor={placeholderColor as string}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-sm"
              style={inputStyle}
            />
          </View>
        </View>
      )}

      <Pressable
        disabled={!canPair}
        onPress={() => void pair()}
        className="items-center rounded-full bg-primary px-5 py-3.5 active:opacity-80 disabled:opacity-40"
      >
        <Text className="text-base font-ryco-bold text-primary-foreground">
          {pairing ? "Pairing…" : "Pair"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
