import {
  ORCHESTRATION_WS_METHODS,
  type AgentTokenMode,
  type ChangeRequest,
  type EnvironmentId,
  type ProviderInteractionMode,
  type ResolvedKeybindingsConfig,
  type RuntimeMode,
  type ServerProvider,
  type SourceControlIssueSummary,
} from "@ryco/contracts";
import type { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { DeviceIcon } from "../DeviceIcon";
import { ListTodoIcon } from "lucide-react";
import { ComposerExpandableLabelControl } from "./ComposerExpandableLabelControl";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import {
  ASK_MODE_UNSUPPORTED_DESCRIPTION,
  CompactComposerControlsMenu,
} from "./CompactComposerControlsMenu";
import { ContextPickerButton } from "./ContextPickerButton";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { PhoneSessionPolicyControl } from "./PhoneSessionPolicySheet";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  CAUTION_RUNTIME_MODE,
  CAUTION_RUNTIME_MODE_CLASS_NAME,
  interactionModeConfig,
  interactionModeOptions,
  runtimeModeConfig,
  runtimeModeOptions,
} from "./sessionPolicyPresentation";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "~/lib/utils";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import type { ContextWindowUsage } from "../../lib/contextWindow";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { AppModelOption } from "../../modelSelection";
import { useUiStateStore } from "../../uiStateStore";
import { tokenModeOptions, tokenModePresentation } from "../../tokenModePresentation";

const SELECT_OPEN_SUPPRESSION_MS = 300;

export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  askModeSupported: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  tokenMode: AgentTokenMode;
  showPlanToggle: boolean;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTokenModeChange: (mode: AgentTokenMode) => void;
  onTogglePlanSidebar: () => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const tokenModeOption = tokenModePresentation[props.tokenMode];
  const TokenModeIcon = tokenModeOption.icon;
  const interactionModeOption = interactionModeConfig[props.interactionMode];
  const InteractionModeIcon = interactionModeOption.icon;
  const wideComposerControlsAutoCollapse = useUiStateStore(
    (state) => state.wideComposerControlsAutoCollapse,
  );
  const [interactionModeSelectOpen, setInteractionModeSelectOpen] = useState(false);
  const [runtimeModeSelectOpen, setRuntimeModeSelectOpen] = useState(false);
  const [tokenModeSelectOpen, setTokenModeSelectOpen] = useState(false);
  const [interactionModeSelectOpenSuppressed, setInteractionModeSelectOpenSuppressed] =
    useState(false);
  const [runtimeModeSelectOpenSuppressed, setRuntimeModeSelectOpenSuppressed] = useState(false);
  const [tokenModeSelectOpenSuppressed, setTokenModeSelectOpenSuppressed] = useState(false);
  const interactionModeSuppressOpenUntilRef = useRef(0);
  const runtimeModeSuppressOpenUntilRef = useRef(0);
  const tokenModeSuppressOpenUntilRef = useRef(0);
  const interactionModeSuppressOpenTimeoutRef = useRef<number | null>(null);
  const runtimeModeSuppressOpenTimeoutRef = useRef<number | null>(null);
  const tokenModeSuppressOpenTimeoutRef = useRef<number | null>(null);
  const isSelectOpenSuppressed = useCallback((suppressUntilRef: { current: number }) => {
    return performance.now() < suppressUntilRef.current;
  }, []);
  const startInteractionModeOpenSuppression = useCallback(() => {
    interactionModeSuppressOpenUntilRef.current = performance.now() + SELECT_OPEN_SUPPRESSION_MS;
    setInteractionModeSelectOpenSuppressed(true);
    if (interactionModeSuppressOpenTimeoutRef.current !== null) {
      window.clearTimeout(interactionModeSuppressOpenTimeoutRef.current);
    }
    interactionModeSuppressOpenTimeoutRef.current = window.setTimeout(() => {
      interactionModeSuppressOpenTimeoutRef.current = null;
      setInteractionModeSelectOpenSuppressed(false);
    }, SELECT_OPEN_SUPPRESSION_MS);
  }, []);
  const startRuntimeModeOpenSuppression = useCallback(() => {
    runtimeModeSuppressOpenUntilRef.current = performance.now() + SELECT_OPEN_SUPPRESSION_MS;
    setRuntimeModeSelectOpenSuppressed(true);
    if (runtimeModeSuppressOpenTimeoutRef.current !== null) {
      window.clearTimeout(runtimeModeSuppressOpenTimeoutRef.current);
    }
    runtimeModeSuppressOpenTimeoutRef.current = window.setTimeout(() => {
      runtimeModeSuppressOpenTimeoutRef.current = null;
      setRuntimeModeSelectOpenSuppressed(false);
    }, SELECT_OPEN_SUPPRESSION_MS);
  }, []);
  const startTokenModeOpenSuppression = useCallback(() => {
    tokenModeSuppressOpenUntilRef.current = performance.now() + SELECT_OPEN_SUPPRESSION_MS;
    setTokenModeSelectOpenSuppressed(true);
    if (tokenModeSuppressOpenTimeoutRef.current !== null) {
      window.clearTimeout(tokenModeSuppressOpenTimeoutRef.current);
    }
    tokenModeSuppressOpenTimeoutRef.current = window.setTimeout(() => {
      tokenModeSuppressOpenTimeoutRef.current = null;
      setTokenModeSelectOpenSuppressed(false);
    }, SELECT_OPEN_SUPPRESSION_MS);
  }, []);
  const closeInteractionModeSelectAfterItemPress = useCallback(() => {
    startInteractionModeOpenSuppression();
    window.setTimeout(() => setInteractionModeSelectOpen(false), 0);
  }, [startInteractionModeOpenSuppression]);
  const closeRuntimeModeSelectAfterItemPress = useCallback(() => {
    startRuntimeModeOpenSuppression();
    window.setTimeout(() => setRuntimeModeSelectOpen(false), 0);
  }, [startRuntimeModeOpenSuppression]);
  const closeTokenModeSelectAfterItemPress = useCallback(() => {
    startTokenModeOpenSuppression();
    window.setTimeout(() => setTokenModeSelectOpen(false), 0);
  }, [startTokenModeOpenSuppression]);

  useEffect(() => {
    return () => {
      if (interactionModeSuppressOpenTimeoutRef.current !== null) {
        window.clearTimeout(interactionModeSuppressOpenTimeoutRef.current);
      }
      if (runtimeModeSuppressOpenTimeoutRef.current !== null) {
        window.clearTimeout(runtimeModeSuppressOpenTimeoutRef.current);
      }
      if (tokenModeSuppressOpenTimeoutRef.current !== null) {
        window.clearTimeout(tokenModeSuppressOpenTimeoutRef.current);
      }
    };
  }, []);

  return (
    <>
      {props.showInteractionModeToggle ? (
        <>
          <Select
            value={props.interactionMode}
            open={interactionModeSelectOpen}
            onOpenChange={(open) => {
              if (open && isSelectOpenSuppressed(interactionModeSuppressOpenUntilRef)) {
                return;
              }
              setInteractionModeSelectOpen(open);
            }}
            onValueChange={(value) => {
              if (!value) return;
              props.onInteractionModeChange(value);
              startInteractionModeOpenSuppression();
              setInteractionModeSelectOpen(false);
            }}
          >
            <SelectTrigger
              variant="ghost"
              size="xs"
              className={cn(
                "group/composer-label-control gap-1 px-1.5 font-medium text-muted-foreground/70 hover:text-foreground/80 sm:px-1.5",
                wideComposerControlsAutoCollapse &&
                  "min-w-7 justify-center px-1 sm:px-1 [&_[data-slot=select-icon]]:hidden",
              )}
              aria-label={`Interaction mode: ${interactionModeOption.triggerLabel}`}
              title={interactionModeOption.description}
            >
              <ComposerExpandableLabelControl
                collapsed={wideComposerControlsAutoCollapse}
                expanded={interactionModeSelectOpen || interactionModeSelectOpenSuppressed}
                icon={<InteractionModeIcon className="size-4 sm:size-3.5" />}
                label={<SelectValue>{interactionModeOption.triggerLabel}</SelectValue>}
              />
            </SelectTrigger>
            <SelectPopup
              alignItemWithTrigger={false}
              className="w-56 p-0.5 [&_[data-slot=select-item]]:min-h-7"
            >
              {interactionModeOptions.map((mode) => {
                const option = interactionModeConfig[mode];
                const OptionIcon = option.icon;
                const unsupported = mode === "ask" && !props.askModeSupported;
                return (
                  <SelectItem
                    key={mode}
                    value={mode}
                    disabled={unsupported}
                    className="min-w-0 py-1.5"
                    onClick={closeInteractionModeSelectAfterItemPress}
                  >
                    <div className="grid min-w-0 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {unsupported ? ASK_MODE_UNSUPPORTED_DESCRIPTION : option.description}
                      </span>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        </>
      ) : null}

      <Select
        value={props.runtimeMode}
        open={runtimeModeSelectOpen}
        onOpenChange={(open) => {
          if (open && isSelectOpenSuppressed(runtimeModeSuppressOpenUntilRef)) {
            return;
          }
          setRuntimeModeSelectOpen(open);
        }}
        onValueChange={(value) => {
          if (!value) return;
          props.onRuntimeModeChange(value);
          startRuntimeModeOpenSuppression();
          setRuntimeModeSelectOpen(false);
        }}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          className={cn(
            "group/composer-label-control gap-1 px-1.5 font-medium sm:px-1.5",
            wideComposerControlsAutoCollapse &&
              "min-w-7 justify-center px-1 sm:px-1 [&_[data-slot=select-icon]]:hidden",
            props.runtimeMode === CAUTION_RUNTIME_MODE && CAUTION_RUNTIME_MODE_CLASS_NAME,
          )}
          aria-label={`Runtime mode: ${runtimeModeOption.triggerLabel}`}
          title={runtimeModeOption.description}
        >
          <ComposerExpandableLabelControl
            collapsed={wideComposerControlsAutoCollapse}
            expanded={runtimeModeSelectOpen || runtimeModeSelectOpenSuppressed}
            icon={<RuntimeModeIcon className="size-4" />}
            label={<SelectValue>{runtimeModeOption.triggerLabel}</SelectValue>}
          />
        </SelectTrigger>
        <SelectPopup
          alignItemWithTrigger={false}
          className="w-56 p-0.5 [&_[data-slot=select-item]]:min-h-7"
        >
          {runtimeModeOptions.map((mode) => {
            const option = runtimeModeConfig[mode];
            const OptionIcon = option.icon;
            return (
              <SelectItem
                key={mode}
                value={mode}
                className="min-w-0 py-1.5"
                onClick={closeRuntimeModeSelectAfterItemPress}
              >
                <div className="grid min-w-0 gap-0.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 font-medium text-foreground",
                      mode === CAUTION_RUNTIME_MODE && CAUTION_RUNTIME_MODE_CLASS_NAME,
                    )}
                    data-runtime-mode-option-label={mode}
                  >
                    <OptionIcon
                      className={cn(
                        "size-3.5 shrink-0",
                        mode !== CAUTION_RUNTIME_MODE && "text-muted-foreground",
                      )}
                    />
                    {option.label}
                  </span>
                  <span
                    className={cn(
                      "text-muted-foreground text-xs leading-4",
                      mode === CAUTION_RUNTIME_MODE && CAUTION_RUNTIME_MODE_CLASS_NAME,
                    )}
                    data-runtime-mode-option-description={mode}
                  >
                    {option.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>

      <Select
        value={props.tokenMode}
        open={tokenModeSelectOpen}
        onOpenChange={(open) => {
          if (open && isSelectOpenSuppressed(tokenModeSuppressOpenUntilRef)) {
            return;
          }
          setTokenModeSelectOpen(open);
        }}
        onValueChange={(value) => {
          if (!value) return;
          props.onTokenModeChange(value as AgentTokenMode);
          startTokenModeOpenSuppression();
          setTokenModeSelectOpen(false);
        }}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          className={cn(
            "group/composer-label-control gap-1 px-1.5 font-medium text-muted-foreground/80 hover:text-foreground/80 sm:px-1.5",
            wideComposerControlsAutoCollapse && "min-w-7 justify-center px-1 sm:px-1",
            wideComposerControlsAutoCollapse && "[&_[data-slot=select-icon]]:hidden",
          )}
          aria-label={`Token mode: ${tokenModeOption.triggerLabel}`}
          title={tokenModeOption.description}
        >
          {wideComposerControlsAutoCollapse ? (
            <ComposerExpandableLabelControl
              collapsed
              expanded={tokenModeSelectOpen || tokenModeSelectOpenSuppressed}
              icon={<TokenModeIcon className="size-4" />}
              label={<SelectValue>{tokenModeOption.triggerLabel}</SelectValue>}
            />
          ) : (
            <>
              <TokenModeIcon className="size-4" />
              <SelectValue>{tokenModeOption.triggerLabel}</SelectValue>
            </>
          )}
        </SelectTrigger>
        <SelectPopup
          alignItemWithTrigger={false}
          className="w-60 p-0.5 [&_[data-slot=select-item]]:min-h-7"
        >
          {tokenModeOptions.map((mode) => {
            const option = tokenModePresentation[mode];
            const OptionIcon = option.icon;
            return (
              <SelectItem
                key={mode}
                value={mode}
                className="min-w-0 py-1.5"
                onClick={closeTokenModeSelectAfterItemPress}
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {option.label}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {option.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>

      {props.showPlanToggle ? (
        <Button
          variant="ghost"
          className={cn(
            "group/composer-label-control shrink-0 whitespace-nowrap px-1.5 sm:px-2",
            props.planSidebarOpen
              ? "text-blue-400 hover:text-blue-300"
              : "text-muted-foreground/70 hover:text-foreground/80",
          )}
          size="xs"
          type="button"
          onClick={props.onTogglePlanSidebar}
          aria-label={props.planSidebarLabel}
          title={
            props.planSidebarOpen
              ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
              : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`
          }
        >
          <ComposerExpandableLabelControl
            collapsed={wideComposerControlsAutoCollapse}
            icon={<ListTodoIcon className="size-4 sm:size-3.5" />}
            label={props.planSidebarLabel}
          />
        </Button>
      ) : null}
    </>
  );
});

export const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  contextWindowUsage: ContextWindowUsage;
  contextWindowRateLimits: ServerProvider["rateLimits"] | undefined;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  sendDisabledReason?: string | null | undefined;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      <ContextWindowMeter
        usage={props.contextWindowUsage}
        rateLimits={props.contextWindowRateLimits}
      />
      {props.isPreparingWorktree ? (
        <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        sendDisabledReason={props.sendDisabledReason}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

export interface ComposerFooterProps {
  isFooterCompact: boolean;
  isPrimaryActionsCompact: boolean;
  isMobileViewport: boolean;
  hideOnMobilePendingAnswers: boolean;

  // Context picker
  environmentId: EnvironmentId;
  gitCwd: string | null;
  hasSourceControlRemote: boolean;
  onSelectIssue: (issue: SourceControlIssueSummary) => void;
  onSelectChangeRequest: (cr: ChangeRequest) => void;
  onAttachFile: (file: File) => void;
  executionTargets?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly disabled?: boolean;
  }>;
  selectedExecutionEnvironmentId?: EnvironmentId;
  executionTargetLocked?: boolean;
  onExecutionTargetChange?: (environmentId: EnvironmentId) => void;

  // Model picker
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  isModelPickerOpen: boolean;
  modelPickerIconClassName?: string | undefined;
  onModelPickerOpenChange: (open: boolean) => void;
  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;

  // Mode controls
  showInteractionModeToggle: boolean;
  askModeSupported: boolean;
  showPlanSidebarToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  tokenMode: AgentTokenMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  providerTraitsMenuContent: ReactNode;
  providerTraitsChips: ReactNode;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTokenModeChange: (mode: AgentTokenMode) => void;

  // Primary actions
  contextWindowUsage: ContextWindowUsage;
  contextWindowRateLimits: ServerProvider["rateLimits"] | undefined;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  sendDisabledReason?: string | null | undefined;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

export const ComposerFooter = memo(function ComposerFooter(props: ComposerFooterProps) {
  // The read-only mutation capability, not a connectivity probe: the composer
  // asks whether the dispatch method is available and renders accordingly. No
  // second readiness or authorization implementation lives here.
  const mutationCapability = useHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand);
  const mutationsBlocked = !mutationCapability.allowed;
  const mutationsBlockedReason = mutationCapability.reason;
  const isPhoneTier = usePresentationTier() === "phone";
  return (
    <div
      data-chat-composer-footer="true"
      data-chat-composer-footer-compact={props.isFooterCompact ? "true" : "false"}
      className={cn(
        "flex min-w-0 flex-nowrap items-center justify-between gap-1.5 overflow-visible px-2 pb-2 sm:px-2.5 sm:pb-2.5",
        props.isFooterCompact ? "gap-1.5" : "sm:gap-0",
        // The flag is only set on the phone tier; the tier-keyed hide keeps
        // the footer's primary actions from doubling the absolute mobile
        // pending-answer overlay at >=640px phone-tier widths.
        props.hideOnMobilePendingAnswers && "phone:hidden",
      )}
    >
      <div className="-m-0.5 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ContextPickerButton
          environmentId={props.environmentId}
          cwd={props.gitCwd ?? ""}
          hasSourceControlRemote={props.hasSourceControlRemote}
          onSelectIssue={props.onSelectIssue}
          onSelectChangeRequest={props.onSelectChangeRequest}
          onAttachFile={props.onAttachFile}
        />
        <ProviderModelPicker
          openOnHover
          compact={props.isFooterCompact}
          activeInstanceId={props.selectedInstanceId}
          model={props.selectedModel}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey}
          instanceEntries={props.providerInstanceEntries}
          keybindings={props.keybindings}
          modelOptionsByInstance={props.modelOptionsByInstance}
          terminalOpen={props.terminalOpen}
          open={props.isModelPickerOpen}
          triggerSize="xs"
          phoneSheet
          disabled={mutationsBlocked}
          {...(mutationsBlockedReason ? { disabledReason: mutationsBlockedReason } : {})}
          {...(props.modelPickerIconClassName
            ? { activeProviderIconClassName: props.modelPickerIconClassName }
            : {})}
          onOpenChange={props.onModelPickerOpenChange}
          onInstanceModelChange={props.onProviderModelSelect}
        />
        {(props.executionTargets?.length ?? 0) > 0 && props.selectedExecutionEnvironmentId ? (
          <>
            <Select
              value={props.selectedExecutionEnvironmentId}
              disabled={props.executionTargetLocked}
              onValueChange={(value) => {
                if (value) props.onExecutionTargetChange?.(value as EnvironmentId);
              }}
            >
              <SelectTrigger
                variant="ghost"
                size="xs"
                className="max-w-40 gap-1 px-1.5 text-muted-foreground/80"
                aria-label="Execution machine"
                title={
                  props.executionTargetLocked
                    ? "Existing threads stay on their owning machine"
                    : "Execution machine"
                }
              >
                <DeviceIcon
                  environmentId={props.selectedExecutionEnvironmentId}
                  className="size-3.5 shrink-0"
                />
                <SelectValue>
                  {props.executionTargets?.find(
                    (target) => target.environmentId === props.selectedExecutionEnvironmentId,
                  )?.label ?? "No verified machine"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} className="w-56 p-0.5">
                {props.executionTargets?.map((target) => (
                  <SelectItem
                    key={target.environmentId}
                    value={target.environmentId}
                    disabled={target.disabled}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <DeviceIcon
                        environmentId={target.environmentId}
                        label={target.label}
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{target.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {!props.executionTargetLocked &&
            props.executionTargets?.find(
              (target) => target.environmentId === props.selectedExecutionEnvironmentId,
            )?.disabled ? (
              <span className="shrink-0 text-destructive text-xs">
                No verified machine available
              </span>
            ) : null}
          </>
        ) : null}

        {isPhoneTier ? (
          <>
            {/* Session policy gets its own control on the phone tier: mode,
                access, and token budget are not model options, and full access
                must not be buried under a model list. */}
            <PhoneSessionPolicyControl
              interactionMode={props.interactionMode}
              runtimeMode={props.runtimeMode}
              tokenMode={props.tokenMode}
              showInteractionModeToggle={props.showInteractionModeToggle}
              askModeSupported={props.askModeSupported}
              showPlanToggle={props.showPlanSidebarToggle}
              planSidebarLabel={props.planSidebarLabel}
              planSidebarOpen={props.planSidebarOpen}
              disabled={mutationsBlocked}
              {...(mutationsBlockedReason ? { disabledReason: mutationsBlockedReason } : {})}
              onInteractionModeChange={props.onInteractionModeChange}
              onRuntimeModeChange={props.onRuntimeModeChange}
              onTokenModeChange={props.onTokenModeChange}
              onTogglePlanSidebar={props.onTogglePlanSidebar}
            />
            {/* The overflow survives only to carry provider traits, which the
                policy sheet does not own. Without traits it would be empty. */}
            {props.providerTraitsMenuContent ? (
              <CompactComposerControlsMenu
                activePlan={props.showPlanSidebarToggle}
                interactionMode={props.interactionMode}
                planSidebarLabel={props.planSidebarLabel}
                planSidebarOpen={props.planSidebarOpen}
                runtimeMode={props.runtimeMode}
                tokenMode={props.tokenMode}
                showInteractionModeToggle={props.showInteractionModeToggle}
                askModeSupported={props.askModeSupported}
                showSessionPolicy={false}
                traitsMenuContent={props.providerTraitsMenuContent}
                onInteractionModeChange={props.onInteractionModeChange}
                onTogglePlanSidebar={props.onTogglePlanSidebar}
                onRuntimeModeChange={props.onRuntimeModeChange}
                onTokenModeChange={props.onTokenModeChange}
              />
            ) : null}
          </>
        ) : props.isFooterCompact ? (
          <CompactComposerControlsMenu
            activePlan={props.showPlanSidebarToggle}
            interactionMode={props.interactionMode}
            planSidebarLabel={props.planSidebarLabel}
            planSidebarOpen={props.planSidebarOpen}
            runtimeMode={props.runtimeMode}
            tokenMode={props.tokenMode}
            showInteractionModeToggle={props.showInteractionModeToggle}
            askModeSupported={props.askModeSupported}
            traitsMenuContent={props.providerTraitsMenuContent}
            onInteractionModeChange={props.onInteractionModeChange}
            onTogglePlanSidebar={props.onTogglePlanSidebar}
            onRuntimeModeChange={props.onRuntimeModeChange}
            onTokenModeChange={props.onTokenModeChange}
          />
        ) : (
          <>
            {props.providerTraitsChips}
            <ComposerFooterModeControls
              showInteractionModeToggle={props.showInteractionModeToggle}
              askModeSupported={props.askModeSupported}
              interactionMode={props.interactionMode}
              runtimeMode={props.runtimeMode}
              tokenMode={props.tokenMode}
              showPlanToggle={props.showPlanSidebarToggle}
              planSidebarLabel={props.planSidebarLabel}
              planSidebarOpen={props.planSidebarOpen}
              onInteractionModeChange={props.onInteractionModeChange}
              onRuntimeModeChange={props.onRuntimeModeChange}
              onTokenModeChange={props.onTokenModeChange}
              onTogglePlanSidebar={props.onTogglePlanSidebar}
            />
          </>
        )}
      </div>

      {/* Right side: send / stop button */}
      <div
        data-chat-composer-actions="right"
        data-chat-composer-primary-actions-compact={
          props.isPrimaryActionsCompact ? "true" : "false"
        }
        className="flex shrink-0 flex-nowrap items-start justify-end gap-2"
      >
        <ComposerFooterPrimaryActions
          compact={props.isPrimaryActionsCompact}
          contextWindowUsage={props.contextWindowUsage}
          contextWindowRateLimits={props.contextWindowRateLimits}
          pendingAction={props.pendingAction}
          isRunning={props.isRunning}
          showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
          promptHasText={props.promptHasText}
          isSendBusy={props.isSendBusy}
          isConnecting={props.isConnecting}
          isEnvironmentUnavailable={props.isEnvironmentUnavailable}
          isPreparingWorktree={props.isPreparingWorktree}
          hasSendableContent={props.hasSendableContent}
          sendDisabledReason={props.sendDisabledReason}
          preserveComposerFocusOnPointerDown={props.isMobileViewport}
          onPreviousPendingQuestion={props.onPreviousPendingQuestion}
          onInterrupt={props.onInterrupt}
          onImplementPlanInNewThread={props.onImplementPlanInNewThread}
        />
      </div>
    </div>
  );
});
