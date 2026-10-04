import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { E2eeActionButton, E2eeIdentityColumn, E2eeSafetyNumberCard } from "./E2eeTrustParts";
import { E2EE_ACKNOWLEDGEMENT_SYMBOLS } from "./e2eeTrustSymbols";
import {
  createE2eeVerificationDraft,
  confirmE2eeApprovalQr,
  deriveE2eeApprovalRequestStatus,
  deriveE2eeVerificationView,
  E2EE_COMPARISON_AFFIRMATION,
  E2EE_PRESENTED_COLUMN_TITLE,
  E2EE_PREVIOUSLY_VERIFIED_COLUMN_TITLE,
  requestE2eeApproval,
  shouldShowE2eeApprovalScanner,
  type E2eeApprovalRequestTone,
} from "./e2eeTrustUiModel";
import { useMobileE2eeSession } from "./useMobileE2eeSession";
import { getMobileHostedConnectionCoordinator } from "../../connection/hostedConnectionCoordinator";
import { useHostedHubStore } from "../../hostedHub/state";
import { resolveExactNodeRoute } from "./exactNodeRouteModel";

/**
 * The §13.2 pairing ceremony and §13.3's re-verification UI.
 *
 * Layout only. The stage machine, every string, the enrollment-fingerprint
 * comparison, and the single action that mints a §13.2 step 5 decision are all
 * `e2eeTrustUiModel.ts`'s.
 */
type Props = StaticScreenProps<{ readonly nodeId: string; readonly environmentId: string }>;

const APPROVAL_TONE_CLASS: Record<E2eeApprovalRequestTone, string> = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
};

export function E2eeNodeVerificationRouteScreen(props: Props) {
  const navigation = useNavigation();
  const nodes = useHostedHubStore((state) => state.nodes);
  const target = resolveExactNodeRoute(props.route.params, nodes);
  const session = useMobileE2eeSession(target?.environmentId ?? "__invalid-node-route__");
  const [draft, setDraft] = useState(createE2eeVerificationDraft);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanningApproval, setScanningApproval] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [approvalRequested, setApprovalRequested] = useState(
    session.selection?.localNodeHandle !== null && session.selection?.localNodeHandle !== undefined,
  );
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const scanHandledRef = useRef(false);
  const placeholderColor = useThemeColor("--color-foreground-muted");
  const iconColor = useThemeColor("--color-icon-muted");
  const targetNodeId = target?.nodeId;
  const targetEnvironmentId = target?.environmentId;

  useEffect(() => {
    if (!targetNodeId || !targetEnvironmentId) return;
    const coordinator = getMobileHostedConnectionCoordinator();
    const release = coordinator.retainPairingScope(targetNodeId, targetEnvironmentId);
    if (!release) return;
    void coordinator.acquireNode(targetNodeId);
    return release;
  }, [targetEnvironmentId, targetNodeId]);

  useEffect(() => {
    if (session.selection?.localNodeHandle) setApprovalRequested(true);
  }, [session.selection?.localNodeHandle]);

  const view = deriveE2eeVerificationView({
    session,
    draft,
    onDraftChange: setDraft,
    onCompleted: () => navigation.goBack(),
    now: () => Date.now(),
  });
  const approval = deriveE2eeApprovalRequestStatus({
    session,
    stage: view.stage,
    approvalRequested,
  });

  const openApprovalScanner = useCallback(async () => {
    setApprovalError(null);
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setApprovalError("Camera permission is needed to scan the node approval code.");
        return;
      }
    }
    scanHandledRef.current = false;
    setScanningApproval(true);
  }, [permission, requestPermission]);

  const scanApproval = useCallback(
    async (payload: string) => {
      if (scanHandledRef.current) return;
      scanHandledRef.current = true;
      setScanningApproval(false);
      setApprovalBusy(true);
      setApprovalError(null);
      const failure = await confirmE2eeApprovalQr({
        session,
        payload,
        decidedAt: Date.now(),
      });
      setApprovalBusy(false);
      if (failure !== null) {
        setApprovalError(failure);
        return;
      }
      try {
        if (!target) throw new Error("Invalid machine route");
        const reconnected = await getMobileHostedConnectionCoordinator().reconnectNode(
          target.nodeId,
          target.environmentId,
        );
        if (!reconnected) throw new Error("Machine reconnect refused");
      } catch {
        setApprovalError(
          "Verification was saved, but Ryco could not reconnect yet. Close this screen and reconnect to the node.",
        );
        return;
      }
      navigation.goBack();
    },
    [navigation, session, target],
  );

  const requestApproval = useCallback(async () => {
    setApprovalBusy(true);
    setApprovalError(null);
    const failure = await requestE2eeApproval(session);
    if (failure !== null) {
      setApprovalBusy(false);
      setApprovalError(failure);
      return;
    }
    try {
      if (!target) throw new Error("Invalid machine route");
      const reconnected = await getMobileHostedConnectionCoordinator().reconnectNode(
        target.nodeId,
        target.environmentId,
      );
      if (!reconnected) throw new Error("Machine reconnect refused");
      setApprovalRequested(true);
    } catch {
      setApprovalRequested(false);
      setApprovalError(
        "The approval request was saved, but Ryco could not reconnect. Try Request approval again.",
      );
    } finally {
      setApprovalBusy(false);
    }
  }, [session, target]);

  if (!target) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1 bg-screen">
        <Text className="mx-5 mt-6 font-sans text-sm leading-relaxed text-danger-foreground">
          This verification link does not match a current machine. Open Machines and choose the
          machine again.
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text className="mx-5 mt-4 text-xl font-ryco-bold text-foreground">
        {recoveryMode ? view.title : "Verify this device"}
      </Text>
      {view.nodeLabel ? (
        <Text className="mx-5 mt-1 font-sans text-sm text-foreground-muted">{view.nodeLabel}</Text>
      ) : null}
      {/* The request's status, whatever the stage: a request whose node identity
          has not arrived yet must say "do not approve yet", not invite approval. */}
      <Text
        className={`mx-5 mt-3 font-sans text-sm leading-relaxed ${
          recoveryMode ? "text-foreground" : APPROVAL_TONE_CLASS[approval.tone]
        }`}
      >
        {recoveryMode ? view.message : approval.message}
      </Text>

      {shouldShowE2eeApprovalScanner(view.stage) && !recoveryMode ? (
        <View className="mx-5 mt-4 rounded-2xl border border-border bg-card p-4">
          <Text className="font-ryco-bold text-base text-foreground">Fastest: scan one code</Text>
          <Text className="mt-1 font-sans text-xs leading-relaxed text-foreground-muted">
            Request approval here, approve this phone in Ryco Desktop under Node Security once its
            safety number matches the one shown here, then scan the code Desktop shows. The code
            works only for this phone.
          </Text>
          {!approvalRequested ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Request node approval"
              disabled={approvalBusy}
              onPress={() => void requestApproval()}
              className="mt-3 h-11 items-center justify-center rounded-full border border-border bg-card-alt px-4 active:opacity-70 disabled:opacity-50"
            >
              <Text className="font-ryco-bold text-sm text-foreground">
                {approvalBusy ? "Requesting…" : "Request approval"}
              </Text>
            </Pressable>
          ) : null}
          {scanningApproval ? (
            <View className="mt-3 overflow-hidden rounded-2xl" style={{ height: 280 }}>
              <CameraView
                style={{ flex: 1 }}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(result) => void scanApproval(result.data)}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel approval QR scan"
                onPress={() => {
                  scanHandledRef.current = true;
                  setScanningApproval(false);
                }}
                className="absolute bottom-3 h-11 self-center justify-center rounded-full bg-primary px-4 active:opacity-70"
              >
                <Text className="font-ryco-bold text-sm text-primary-foreground">Cancel scan</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scan node approval QR code"
              disabled={approvalBusy || !approvalRequested}
              onPress={() => void openApprovalScanner()}
              className="mt-3 h-11 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-50"
            >
              <Text className="font-ryco-bold text-sm text-primary-foreground">
                {approvalBusy ? "Verifying…" : "Scan approval QR"}
              </Text>
            </Pressable>
          )}
          {approvalError ? (
            <Text className="mt-2 font-sans text-xs leading-relaxed text-danger-foreground">
              {approvalError}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* §13.2 step 4 on the fast path: the full number the owner matches against
          the Desktop row before approving it. Never a fingerprint tail. */}
      {!recoveryMode && approval.comparison ? (
        <E2eeSafetyNumberCard
          groups={approval.comparison.groups}
          caption={approval.comparison.caption}
          value={approval.comparison.value}
        />
      ) : null}

      {/* §13.2.1 situation 2 alone: the previously verified pair beside the newly
          presented one, before any pairing step proceeds. */}
      {recoveryMode && view.previouslyVerified && view.presented ? (
        <View className="mx-5 mt-4 flex-row gap-3">
          <E2eeIdentityColumn
            title={E2EE_PREVIOUSLY_VERIFIED_COLUMN_TITLE}
            identity={view.previouslyVerified}
          />
          <E2eeIdentityColumn title={E2EE_PRESENTED_COLUMN_TITLE} identity={view.presented} />
        </View>
      ) : null}

      {recoveryMode && view.stage === "enrollment-fingerprint" ? (
        <View className="mx-5 mt-4">
          <TextInput
            accessibilityLabel="Node enrollment fingerprint"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={view.fingerprintPlaceholder}
            placeholderTextColor={placeholderColor as string}
            value={view.fingerprintValue}
            onChangeText={view.onChangeFingerprint}
            className="rounded-2xl border border-border bg-card px-4 py-3 font-mono text-sm text-foreground"
          />
          {view.fingerprintError ? (
            <Text className="mt-2 font-sans text-xs leading-relaxed text-danger-foreground">
              {view.fingerprintError}
            </Text>
          ) : null}
        </View>
      ) : null}

      {recoveryMode && view.stage === "compare" ? (
        <>
          <E2eeSafetyNumberCard
            groups={view.safetyNumberGroups}
            caption={view.safetyNumberCaption}
            value={view.presented?.safetyNumber ?? ""}
          />
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: view.comparisonAcknowledged }}
            onPress={() => view.onAcknowledgeComparison(!view.comparisonAcknowledged)}
            className="mx-5 mt-4 flex-row items-start gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
          >
            <SymbolView
              name={
                view.comparisonAcknowledged
                  ? E2EE_ACKNOWLEDGEMENT_SYMBOLS.checked
                  : E2EE_ACKNOWLEDGEMENT_SYMBOLS.unchecked
              }
              size={18}
              tintColor={iconColor}
              type="monochrome"
            />
            <Text className="flex-1 font-sans text-sm leading-relaxed text-foreground">
              {E2EE_COMPARISON_AFFIRMATION}
            </Text>
          </Pressable>
        </>
      ) : null}

      {view.errorMessage ? (
        <Text className="mx-5 mt-4 font-sans text-sm leading-relaxed text-danger-foreground">
          {view.errorMessage}
        </Text>
      ) : null}

      {/* ABSENT until the owner has said they compared — never a disabled button
          that a stray press could re-enable. */}
      {recoveryMode && view.confirm ? (
        <E2eeActionButton action={view.confirm} onConfirm={(action) => action.run()} />
      ) : null}

      {recoveryMode ? (
        <>
          <Text className="mx-5 mt-6 font-sans text-xs leading-relaxed text-foreground-muted">
            {view.nodeApprovalMessage}
          </Text>
          <Text className="mx-5 mt-3 font-sans text-xs leading-relaxed text-foreground-muted">
            {view.outcomeMessage}
          </Text>
        </>
      ) : null}

      {view.stage === "enrollment-fingerprint" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recoveryMode ? "Use approval QR instead" : "Use recovery setup"}
          onPress={() => setRecoveryMode((current) => !current)}
          className="mx-5 mt-5 h-11 items-center justify-center rounded-full px-4 active:opacity-70"
        >
          <Text className="font-ryco-bold text-sm text-foreground-muted">
            {recoveryMode ? "Use approval QR instead" : "Use recovery setup"}
          </Text>
        </Pressable>
      ) : null}

      <E2eeActionButton
        action={view.dismiss}
        onConfirm={(action) => action.run()}
        variant="quiet"
      />
    </ScrollView>
  );
}
