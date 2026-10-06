import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  CameraIcon,
  CheckIcon,
  CopyIcon,
  GitBranchIcon,
  ImageUpIcon,
  PencilIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { createElement, useRef, useState } from "react";

import { openInPreferredEditor } from "../../../editorPreferences";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { useGitStatus } from "../../../lib/gitStatusState";
import { cn } from "../../../lib/utils";
import { readLocalApi } from "../../../localApi";
import {
  openProjectRemote,
  projectAvatarUploadUnavailableReason,
  removeProjectAvatar,
  updateProjectMeta,
  uploadProjectAvatar,
} from "../../../projectMutations";
import { buildPullRequestsPageLocation } from "../../../pullRequestsRoute";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import { ProjectFavicon } from "../../ProjectFavicon";
import {
  formatRepositoryProviderLabel,
  resolveRepositoryProviderIcon,
} from "../../sidebar/sidebarProjectRemoteLink";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { Spinner } from "../../ui/spinner";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import {
  formatProjectPath,
  inferHomeDirectory,
  projectRepositoryLabel,
} from "../projectsModel.logic";
import { useProjectsSelection } from "../ProjectsPageContext";
import { SavedTick, useSavedFlash } from "../sections/ProjectSection";
import { useHeroSentinel } from "./ProjectDetailContext";

function toastFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The project image. Clicking it offers upload and, for a custom image,
 * removal; read-only checkouts show it plain. `compact` sizes it for the
 * map's inspector.
 */
export function ProjectImage(props: {
  readonly member: SidebarProjectGroupMember;
  readonly canEdit: boolean;
  readonly compact?: boolean;
}) {
  const { member } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const uploadUnavailable = projectAvatarUploadUnavailableReason();
  const hasCustomImage = Boolean(member.customAvatarContentHash);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      await uploadProjectAvatar(member, file);
    } catch (error) {
      toastFailure("Failed to upload the project image", error);
    } finally {
      setUploading(false);
    }
  };
  const image = (
    <>
      <ProjectFavicon
        environmentId={member.environmentId}
        cwd={member.cwd}
        projectId={member.id}
        customAvatarContentHash={member.customAvatarContentHash ?? null}
        fillContainer
      />
      {uploading ? (
        <span className="absolute inset-0 grid place-items-center bg-background/70">
          <Spinner className="size-4" />
        </span>
      ) : null}
    </>
  );
  const frameClass = cn(
    "relative grid shrink-0 place-items-center overflow-hidden border border-border/70 bg-muted text-muted-foreground",
    props.compact
      ? "size-10 rounded-[min(var(--radius-lg),0.625rem)]"
      : "size-14 rounded-[min(var(--radius-xl),0.875rem)]",
  );
  if (!props.canEdit) return <span className={frameClass}>{image}</span>;
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Change project image"
              disabled={uploading}
              className={`group/image ${frameClass} outline-hidden focus-visible:ring-2 focus-visible:ring-ring data-popup-open:ring-2 data-popup-open:ring-ring/50`}
            />
          }
        >
          {image}
          <span
            aria-hidden
            className="absolute inset-0 grid place-items-center bg-foreground/45 text-background opacity-0 transition-opacity duration-(--app-motion-duration-chip) group-hover/image:opacity-100 group-focus-visible/image:opacity-100 group-data-popup-open/image:opacity-100"
          >
            <CameraIcon className="size-4" />
          </span>
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-56">
          <MenuItem
            disabled={uploadUnavailable !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImageUpIcon className="size-4" />
            {hasCustomImage ? "Replace image…" : "Upload image…"}
          </MenuItem>
          {uploadUnavailable ? (
            <p className="max-w-64 px-2 pb-1.5 text-[11px] text-muted-foreground">
              {uploadUnavailable}
            </p>
          ) : (
            <p className="max-w-64 px-2 pb-1.5 text-[11px] text-muted-foreground">
              {hasCustomImage
                ? "PNG, JPG or WebP, up to 2 MB."
                : "Detected from the project’s favicon until you upload one."}
            </p>
          )}
          {hasCustomImage ? (
            <>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={() =>
                  void removeProjectAvatar(member).catch((error: unknown) =>
                    toastFailure("Failed to remove the project image", error),
                  )
                }
              >
                <Trash2Icon className="size-4" />
                Use the detected image
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }}
      />
    </>
  );
}

/**
 * A name edited where it is read: it looks like the heading until it is
 * hovered or focused. Enter or leaving saves, Escape puts it back. The saved
 * name shows straight away; a failed save returns it to the old one.
 */
export function InlineNameField(props: {
  /** The saved name. */
  readonly value: string;
  readonly label: string;
  readonly canEdit: boolean;
  readonly compact?: boolean;
  /** Shown when the name is cleared. */
  readonly emptyMessage: string;
  readonly failureTitle: string;
  readonly onSave: (name: string) => Promise<unknown>;
}) {
  const saved = useSavedFlash();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // The record caught up with the save.
  if (pending !== null && props.value === pending) setPending(null);
  const value = draft ?? pending ?? props.value;

  const commit = () => {
    if (draft === null) return;
    const name = draft.trim();
    setDraft(null);
    if (name === props.value) return;
    if (name.length === 0) {
      toastManager.add({ type: "warning", title: props.emptyMessage });
      return;
    }
    setPending(name);
    props.onSave(name).then(saved.flash, (error: unknown) => {
      setPending(null);
      toastFailure(props.failureTitle, error);
    });
  };

  return (
    <div className="group/name flex min-w-0 items-center gap-1.5">
      <input
        aria-label={props.label}
        value={value}
        disabled={!props.canEdit}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape" && draft !== null) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
            // Blurred once the reset has rendered, so leaving commits nothing.
            const input = event.currentTarget;
            requestAnimationFrame(() => input.blur());
          }
        }}
        className={cn(
          "projects-name-field -mx-1.5 min-w-[4ch] max-w-full truncate rounded-[min(var(--radius-md),0.5rem)] bg-transparent px-1.5 py-0.5 leading-tight font-semibold text-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) enabled:hover:bg-accent/60 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
          props.compact ? "text-[16px] tracking-tight" : "text-[1.375rem] tracking-[-0.02em]",
        )}
      />
      {props.canEdit ? (
        <PencilIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-(--app-motion-duration-chip) group-hover/name:opacity-70 group-focus-within/name:opacity-0"
        />
      ) : null}
      <SavedTick token={saved.token} />
    </div>
  );
}

/** The project's name, edited in place. */
export function ProjectNameField(props: {
  readonly member: SidebarProjectGroupMember;
  readonly canEdit: boolean;
  readonly compact?: boolean;
}) {
  const { member } = props;
  return (
    <InlineNameField
      value={member.name}
      label="Project name"
      canEdit={props.canEdit}
      {...(props.compact ? { compact: true } : {})}
      emptyMessage="Project name cannot be empty"
      failureTitle="Failed to rename project"
      onSave={(title) => updateProjectMeta(member, { title })}
    />
  );
}

/** Repository, branch and where the files are: one quiet line under the name. */
function ProjectMetaLine(props: {
  readonly snapshot: SidebarProjectSnapshot;
  readonly member: SidebarProjectGroupMember;
}) {
  const { snapshot, member } = props;
  const gitStatus = useGitStatus({ environmentId: member.environmentId, cwd: member.cwd });
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1200 });
  const repository = projectRepositoryLabel(member.repositoryIdentity);
  const providerIcon = resolveRepositoryProviderIcon(
    member.repositoryIdentity?.provider ?? undefined,
  );
  const status = gitStatus.data;
  const branch = status?.isRepo ? status.refName : null;
  const path = formatProjectPath(member.cwd, inferHomeDirectory(member.cwd));
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-0.5">
        <span className="truncate font-mono text-[11px]" title={member.cwd}>
          {path}
        </span>
        <button
          type="button"
          aria-label={isCopied ? "Path copied" : "Copy path"}
          onClick={() => copyToClipboard(member.cwd)}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            key={isCopied ? "copied" : "copy"}
            className="app-icon-swap grid place-items-center"
          >
            {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </span>
        </button>
      </span>
      {repository ? (
        <button
          type="button"
          onClick={() => openProjectRemote(member)}
          className="inline-flex min-w-0 items-center gap-1 rounded-sm outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {createElement(providerIcon, { className: "size-3.5 shrink-0" })}
          {/* A grouped project is already named after its repository; say where it lives. */}
          <span className="truncate">
            {repository === snapshot.displayName
              ? formatRepositoryProviderLabel(member.repositoryIdentity?.provider ?? undefined)
              : repository}
          </span>
        </button>
      ) : null}
      {branch ? (
        <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px]">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
          {status && status.aheadCount > 0 ? (
            <span className="inline-flex items-center tabular-nums" title="Commits to push">
              <ArrowUpIcon className="size-3" />
              {status.aheadCount}
            </span>
          ) : null}
          {status && status.behindCount > 0 ? (
            <span className="inline-flex items-center tabular-nums" title="Commits to pull">
              <ArrowDownIcon className="size-3" />
              {status.behindCount}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The project's identity, editable in place — image and name — with where it
 * lives and the things people come here to start. The bar title takes over
 * once this scrolls away.
 */
export function ProjectHero(props: { readonly canEdit: boolean }) {
  const navigate = useNavigate();
  const { snapshot, member } = useProjectsSelection();
  const sentinelRef = useHeroSentinel();
  const { handleNewThread } = useNewThreadHandler();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The editor bridge opens folders on this machine only.
  const canOpenInEditor =
    member.environmentId === primaryEnvironmentId && readLocalApi() !== undefined;
  // Grouped checkouts are listed under a shared name; say so when it differs.
  const listedAs =
    snapshot.memberProjects.length > 1 && snapshot.displayName !== member.name
      ? snapshot.displayName
      : null;

  return (
    <header className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 items-center gap-4">
        <ProjectImage member={member} canEdit={props.canEdit} />
        <div className="min-w-0 flex-1">
          <ProjectNameField member={member} canEdit={props.canEdit} />
          <ProjectMetaLine snapshot={snapshot} member={member} />
          {listedAs ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Grouped in the sidebar as “{listedAs}”.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!props.canEdit}
          onClick={() => void handleNewThread(scopeProjectRef(member.environmentId, member.id))}
        >
          <SquarePenIcon className="size-3.5" />
          New thread
        </Button>
        {canOpenInEditor ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const api = readLocalApi();
              if (!api) return;
              void openInPreferredEditor(api, member.cwd).catch((error: unknown) =>
                toastFailure("Unable to open the project", error),
              );
            }}
          >
            <SquareTerminalIcon className="size-3.5" />
            Open in editor
          </Button>
        ) : null}
        {member.repositoryIdentity ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigate(
                buildPullRequestsPageLocation({
                  environmentId: member.environmentId,
                  projectId: member.id,
                }),
              )
            }
          >
            Pull requests
            <ArrowUpRightIcon className="size-3.5 opacity-60" />
          </Button>
        ) : null}
      </div>
      <span ref={sentinelRef} aria-hidden className="block h-px" />
    </header>
  );
}
