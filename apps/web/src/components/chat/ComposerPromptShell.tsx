import type { ComposerSourceControlContext, ServerProviderSkill } from "@ryco/contracts";
import { AttachmentPreviewButton } from "./AttachmentDocumentPreview";
import { formatAttachmentBytes } from "./attachmentPreview";
import { memo } from "react";
import { CircleAlertIcon, FileIcon, PaperclipIcon, RotateCcwIcon, XIcon } from "lucide-react";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import type { ChatFileUploadRecord } from "../../composerFileUpload";
import { isFileUploadTokenUsable } from "../../composerFileUpload";
import type { ComposerTrigger } from "../../composer-logic";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { SessionPhase, Thread } from "../../types";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ComposerCommandMenuOverlay } from "./ComposerAttachmentMenus";
import { type ComposerCommandItem } from "./ComposerCommandMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { SourceControlContextChip } from "./SourceControlContextChip";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

interface ComposerPromptShellPendingProgress {
  customAnswer: string;
}

interface ComposerPromptShellPendingPrimaryAction {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

export interface ComposerPromptShellProps {
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;

  isComposerCollapsedMobile: boolean;
  hasComposerHeader: boolean;
  isComposerApprovalState: boolean;
  resolvedTheme: "light" | "dark";

  // Command menu overlay
  composerMenuOpen: boolean;
  composerMenuItems: ComposerCommandItem[];
  isComposerMenuLoading: boolean;
  composerTriggerKind: ComposerTrigger["kind"] | null;
  composerTrigger: ComposerTrigger | null;
  composerMenuEmptyState: string;
  activeComposerMenuItemId: string | null;
  onComposerMenuItemHighlighted: (itemId: string | null) => void;
  onSelectComposerItem: (item: ComposerCommandItem) => void;

  // Source-control context chips
  composerSourceControlContexts: ReadonlyArray<ComposerSourceControlContext>;
  onRemoveSourceControlContext: (id: string) => void;

  // Image attachments
  composerImages: ComposerImageAttachment[];
  nonPersistedComposerImageIdSet: ReadonlySet<string>;
  fileUploadRecords: ReadonlyMap<string, ChatFileUploadRecord>;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemoveImage: (imageId: string) => void;
  onRetryFileUpload: (imageId: string) => void;
  onReattachFile: (imageId: string) => void;

  // Prompt editor
  pendingUserInputCount: number;
  prompt: string;
  composerCursor: number;
  composerTerminalContexts: TerminalContextDraft[];
  skills: ReadonlyArray<ServerProviderSkill>;
  showMobilePendingAnswerActions: boolean;
  onRemoveTerminalContext: (contextId: string) => void;
  onPromptChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => void;
  onComposerCommandKey: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onComposerPaste: (event: React.ClipboardEvent<HTMLElement>) => void;

  // Placeholder / disabled state
  activePendingProgress: ComposerPromptShellPendingProgress | null;
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  environmentUnavailable: {
    readonly label: string;
    readonly connectionState: "connecting" | "disconnected" | "error";
  } | null;
  phase: SessionPhase;
  isConnecting: boolean;
  /**
   * A disabled editor is not editable, so it cannot take the activating tap.
   * The collapsed surface needs its own expand path in that state.
   */
  isEditorDisabled: boolean;

  // Collapsed phone send affordance, rendered beside the collapsed editor.
  showCollapsedSendAction: boolean;
  collapsedSendActionLabel: string;
  collapsedSendActionDisabled: boolean;
  onCollapsedSend: () => void;

  // Mobile pending answer actions
  isSendBusy: boolean;
  pendingPrimaryAction: ComposerPromptShellPendingPrimaryAction | null;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

/**
 * Prompt editor layout shell: command menu overlay, source-control/image
 * attachment previews, and the Lexical-backed prompt editor. Purely
 * presentational — all state and handlers are owned by ChatComposer.
 */
export const ComposerPromptShell = memo(function ComposerPromptShell(
  props: ComposerPromptShellProps,
) {
  const {
    editorRef,
    isComposerCollapsedMobile,
    hasComposerHeader,
    isComposerApprovalState,
    resolvedTheme,
    composerMenuOpen,
    composerMenuItems,
    isComposerMenuLoading,
    composerTriggerKind,
    composerTrigger,
    composerMenuEmptyState,
    activeComposerMenuItemId,
    onComposerMenuItemHighlighted,
    onSelectComposerItem,
    composerSourceControlContexts,
    onRemoveSourceControlContext,
    composerImages,
    nonPersistedComposerImageIdSet,
    fileUploadRecords,
    onExpandImage,
    onRemoveImage,
    onRetryFileUpload,
    onReattachFile,
    pendingUserInputCount,
    prompt,
    composerCursor,
    composerTerminalContexts,
    skills,
    showMobilePendingAnswerActions,
    onRemoveTerminalContext,
    onPromptChange,
    onComposerCommandKey,
    onComposerPaste,
    activePendingProgress,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    environmentUnavailable,
    phase,
    isConnecting,
    isEditorDisabled,
    showCollapsedSendAction,
    collapsedSendActionLabel,
    collapsedSendActionDisabled,
    onCollapsedSend,
    isSendBusy,
    pendingPrimaryAction,
    onPreviousPendingQuestion,
    onInterrupt,
    onImplementPlanInNewThread,
  } = props;

  return (
    <div
      className={cn(
        "relative px-3 pb-2 sm:px-4",
        hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
      )}
    >
      <ComposerCommandMenuOverlay
        open={composerMenuOpen && !isComposerApprovalState}
        items={composerMenuItems}
        resolvedTheme={resolvedTheme}
        isLoading={isComposerMenuLoading}
        triggerKind={composerTriggerKind}
        groupSlashCommandSections={
          composerTrigger?.kind === "slash-command" && composerTrigger.query.trim().length === 0
        }
        emptyStateText={composerMenuEmptyState}
        activeItemId={activeComposerMenuItemId}
        onHighlightedItemChange={onComposerMenuItemHighlighted}
        onSelect={onSelectComposerItem}
      />

      {!isComposerCollapsedMobile &&
        !isComposerApprovalState &&
        pendingUserInputCount === 0 &&
        composerSourceControlContexts.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {composerSourceControlContexts.map((ctx) => (
              <SourceControlContextChip
                key={ctx.id}
                context={ctx}
                onRemove={onRemoveSourceControlContext}
              />
            ))}
          </div>
        )}

      {!isComposerCollapsedMobile &&
        !isComposerApprovalState &&
        pendingUserInputCount === 0 &&
        composerImages.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {composerImages.map((image) =>
              image.type === "file" ? (
                <ComposerFileAttachmentRow
                  key={image.id}
                  image={image}
                  status={fileUploadRecords.get(image.id)?.status}
                  onRemove={onRemoveImage}
                  onRetry={onRetryFileUpload}
                  onReattach={onReattachFile}
                />
              ) : (
                <div
                  key={image.id}
                  className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                >
                  {image.previewUrl ? (
                    <button
                      type="button"
                      className="h-full w-full cursor-zoom-in"
                      aria-label={`Preview ${image.name}`}
                      onClick={() => {
                        const preview = buildExpandedImagePreview(composerImages, image.id);
                        if (!preview) return;
                        onExpandImage(preview);
                      }}
                    >
                      <img
                        src={image.previewUrl}
                        alt={image.name}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                      {image.name}
                    </div>
                  )}
                  {nonPersistedComposerImageIdSet.has(image.id) && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            role="img"
                            aria-label="Draft attachment may not persist"
                            className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                          >
                            <CircleAlertIcon className="size-3" />
                          </span>
                        }
                      />
                      <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
                        Draft attachment could not be saved locally and may be lost on navigation.
                      </TooltipPopup>
                    </Tooltip>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                    onClick={() => onRemoveImage(image.id)}
                    aria-label={`Remove ${image.name}`}
                  >
                    <XIcon />
                  </Button>
                </div>
              ),
            )}
          </div>
        )}

      <div className={cn("relative", showCollapsedSendAction && "flex items-center gap-2")}>
        {/* Stable wrapper: the editor keeps the same position in the tree
            across collapse and expand, so the activating tap's focus is never
            lost to a remount. */}
        <div className="min-w-0 flex-1">
          <ComposerPromptEditor
            ref={editorRef}
            collapsed={isComposerCollapsedMobile}
            value={
              isComposerApprovalState
                ? ""
                : activePendingProgress
                  ? activePendingProgress.customAnswer
                  : prompt
            }
            cursor={composerCursor}
            terminalContexts={
              !isComposerApprovalState && pendingUserInputCount === 0
                ? composerTerminalContexts
                : []
            }
            skills={skills}
            {...(showMobilePendingAnswerActions ? { className: "phone:pb-11" } : {})}
            onRemoveTerminalContext={onRemoveTerminalContext}
            onChange={onPromptChange}
            onCommandKeyDown={onComposerCommandKey}
            onPaste={onComposerPaste}
            placeholder={
              isComposerApprovalState
                ? // The full approval detail renders as a scrollable block in the
                  // pending-approval panel; the clipped placeholder only carries
                  // the generic hint.
                  "Resolve this approval request to continue"
                : activePendingProgress
                  ? // Collapsed keeps its own shorter wording: the one-line
                    // presentation cannot show the expanded hint.
                    isComposerCollapsedMobile
                    ? "Write custom answer"
                    : "Type your own answer, or leave this blank to use the selected option"
                  : showPlanFollowUpPrompt && activeProposedPlan
                    ? isComposerCollapsedMobile
                      ? "Add plan feedback"
                      : "Add feedback to refine the plan, or leave this blank to implement it"
                    : environmentUnavailable
                      ? `${environmentUnavailable.label} is ${
                          environmentUnavailable.connectionState === "connecting"
                            ? "connecting"
                            : "disconnected"
                        }`
                      : phase === "disconnected"
                        ? "Ask for follow-up changes or attach images"
                        : isComposerCollapsedMobile
                          ? "Ask anything..."
                          : "Ask anything, @tag files/folders, or use / to show available commands"
            }
            disabled={isEditorDisabled}
          />
        </div>
        {showCollapsedSendAction ? (
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground disabled:opacity-30"
            disabled={collapsedSendActionDisabled}
            aria-label={collapsedSendActionLabel}
            // Not about focus movement: engines that focus buttons on
            // pointerdown (Chromium, Android) would expand the composer through
            // the surface's onFocusCapture, which unmounts this very button
            // before `click` is dispatched, so the send would never run.
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onCollapsedSend();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 3L8 13M8 3L4 7M8 3L12 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        {showMobilePendingAnswerActions ? (
          <div
            data-chat-composer-mobile-pending-actions="true"
            className="absolute bottom-0 right-0 flex justify-end"
          >
            <ComposerPrimaryActions
              compact
              pendingAction={pendingPrimaryAction}
              isRunning={false}
              showPlanFollowUpPrompt={false}
              promptHasText={false}
              isSendBusy={isSendBusy}
              isConnecting={isConnecting}
              isEnvironmentUnavailable={environmentUnavailable !== null}
              isPreparingWorktree={false}
              hasSendableContent={false}
              preserveComposerFocusOnPointerDown
              onPreviousPendingQuestion={onPreviousPendingQuestion}
              onInterrupt={onInterrupt}
              onImplementPlanInNewThread={onImplementPlanInNewThread}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
});

const ComposerFileAttachmentRow = memo(function ComposerFileAttachmentRow({
  image,
  status,
  onRemove,
  onRetry,
  onReattach,
}: {
  image: ComposerImageAttachment;
  status: ChatFileUploadRecord["status"] | undefined;
  onRemove: (imageId: string) => void;
  onRetry: (imageId: string) => void;
  onReattach: (imageId: string) => void;
}) {
  // A byte-less row without an engine record can still carry a valid upload
  // token (rolled-back send or stash snapshot); only genuinely unattached
  // files need the "attach again" flow.
  const hasValidUploadToken =
    image.uploadToken !== undefined &&
    image.expiresAt !== undefined &&
    isFileUploadTokenUsable(image.expiresAt, Date.now());
  const needsReattach =
    status === undefined
      ? image.file === null && !hasValidUploadToken
      : status.kind === "needsReattach";
  const isUploading = status?.kind === "uploading" || status?.kind === "pending";
  const isUploaded = status?.kind === "uploaded";
  const progress = status?.kind === "uploading" ? status.progress : null;
  return (
    <div
      className="relative flex h-16 min-w-44 max-w-56 items-center gap-2 overflow-hidden rounded-lg border border-border/80 bg-background px-3 py-2"
      data-composer-file-state={
        needsReattach ? "reattach" : isUploading ? "uploading" : isUploaded ? "uploaded" : "ready"
      }
    >
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{image.name}</span>
        {needsReattach ? (
          <span className="flex items-center gap-1 text-[10px] text-amber-600">
            <span>Attach again to send</span>
            <button
              type="button"
              className="cursor-pointer font-medium underline underline-offset-2"
              onClick={() => onReattach(image.id)}
              aria-label={`Attach ${image.name} again`}
            >
              <PaperclipIcon className="inline size-3 align-[-2px]" /> Attach again
            </button>
          </span>
        ) : status?.kind === "failed" ? (
          <span className="flex items-center gap-1 text-[10px] text-destructive">
            <span>Upload failed</span>
            <button
              type="button"
              className="cursor-pointer font-medium underline underline-offset-2"
              onClick={() => onRetry(image.id)}
              aria-label={`Retry uploading ${image.name}`}
            >
              <RotateCcwIcon className="inline size-3 align-[-2px]" /> Retry
            </button>
          </span>
        ) : isUploading ? (
          <span className="block text-[10px] text-muted-foreground">
            Uploading{progress !== null ? ` ${Math.round(progress * 100)}%` : "…"}
          </span>
        ) : (
          <span className="block text-[10px] text-muted-foreground">
            {formatAttachmentBytes(image.sizeBytes)}
            {isUploaded ? " · Uploaded" : ""}
          </span>
        )}
      </span>
      {progress !== null && (
        <span className="absolute bottom-0 left-0 h-0.5 w-full bg-muted">
          <span
            className="block h-full bg-primary transition-[width] duration-200"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </span>
      )}
      <AttachmentPreviewButton attachment={image} />
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
        onClick={() => onRemove(image.id)}
        aria-label={`Remove ${image.name}`}
      >
        <XIcon />
      </Button>
    </div>
  );
});
