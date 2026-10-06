import { ExternalLinkIcon, GitBranchIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { ensureEnvironmentApi } from "../../../environmentApi";
import { refreshGitStatus, useGitStatus } from "../../../lib/gitStatusState";
import { cn } from "../../../lib/utils";
import { openProjectRemote, updateProjectMeta } from "../../../projectMutations";
import { SettingsBlock, SettingsEmpty } from "../../settings/settingsLayout";
import { resolveRepositoryProviderIcon } from "../../sidebar/sidebarProjectRemoteLink";
import { Button } from "../../ui/button";
import { rovingRadioGroup } from "../../ui/roving-radio-group";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { ProjectSection, useSavedFlash } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

/** "Auto-detect" in the radio group; git remote names are never empty. */
const AUTO_REMOTE = "";

/** The radio dot every remote row shares. */
function RadioDot(props: { readonly checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-(--app-motion-duration-chip)",
        props.checked ? "border-foreground" : "border-muted-foreground/40",
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full bg-foreground transition-[scale,opacity] duration-(--app-motion-duration-pop) ease-(--app-motion-spring-snappy)",
          props.checked ? "scale-100 opacity-100" : "scale-50 opacity-0",
        )}
      />
    </span>
  );
}

/**
 * The checkout's git remotes and which one is primary: "Open remote", the
 * pull requests page and links use it. Auto-detect follows the server's
 * choice (upstream, then origin, then the first).
 */
export function ProjectRepositorySection({ member, canEdit }: ProjectSectionProps) {
  const saved = useSavedFlash();
  const identity = member.repositoryIdentity ?? null;
  const remotes = identity?.remotes ?? [];
  const autoRemoteName = identity?.locator.remoteName ?? null;
  const preferred =
    member.preferredRemoteName &&
    remotes.some((remote) => remote.name === member.preferredRemoteName)
      ? member.preferredRemoteName
      : null;
  const gitStatus = useGitStatus(
    { environmentId: member.environmentId, cwd: member.cwd },
    { enabled: identity === null },
  );
  const notARepository = identity === null && gitStatus.data?.isRepo === false;
  const multipleRemotes = remotes.length > 1;
  // One Tab stop for the group; arrows move and select (ARIA radio group).
  const remoteGroup = rovingRadioGroup({
    options: [AUTO_REMOTE, ...remotes.map((remote) => remote.name)].map((value) => ({
      value,
      disabled: !canEdit,
    })),
    value: preferred ?? AUTO_REMOTE,
    onChange: (value) => choose(value === AUTO_REMOTE ? null : value),
  });
  const [initializing, setInitializing] = useState(false);

  const choose = (remoteName: string | null) => {
    if (remoteName === preferred) return;
    updateProjectMeta(member, { preferredRemoteName: remoteName }).then(
      saved.flash,
      (error: unknown) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to change the primary remote",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        ),
    );
  };

  const initializeGit = async () => {
    setInitializing(true);
    try {
      await ensureEnvironmentApi(member.environmentId).vcs.init({ cwd: member.cwd });
      void refreshGitStatus({ environmentId: member.environmentId, cwd: member.cwd });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not initialize git",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setInitializing(false);
    }
  };

  return (
    <ProjectSection
      section="repository"
      savedToken={saved.token}
      description={
        remotes.length > 1
          ? "The primary remote is the one Open remote and pull requests use."
          : undefined
      }
    >
      {remotes.length === 0 ? (
        <SettingsEmpty
          icon={<GitBranchIcon />}
          title={notARepository ? "Not a git repository" : "No remote"}
          description={
            notARepository
              ? "Initialize git to track changes, create worktrees and open pull requests."
              : "Add a remote to the repository to open it in the browser and review its pull requests here."
          }
          action={
            notARepository ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || initializing}
                onClick={() => void initializeGit()}
              >
                {initializing ? "Initializing…" : "Initialize git"}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div
          {...(multipleRemotes
            ? {
                role: "radiogroup",
                "aria-label": "Primary remote",
                // The interleaved Open buttons are not radios; arrows there do nothing.
                onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest("[data-radio-value]")
                  ) {
                    remoteGroup.onKeyDown(event);
                  }
                },
              }
            : {})}
        >
          {multipleRemotes ? (
            <SettingsBlock className="py-0">
              <button
                {...remoteGroup.radio(AUTO_REMOTE)}
                className="flex w-full items-center gap-3 py-3 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
              >
                <RadioDot checked={preferred === null} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">Auto-detect</span>
                  {autoRemoteName ? (
                    <span className="block text-xs text-muted-foreground">
                      Currently {autoRemoteName}
                    </span>
                  ) : null}
                </span>
              </button>
            </SettingsBlock>
          ) : null}
          {remotes.map((remote) => {
            const ProviderIcon = resolveRepositoryProviderIcon(remote.provider ?? undefined);
            const primary =
              remote.name === (preferred ?? autoRemoteName) &&
              (preferred !== null || remotes.length === 1);
            return (
              <SettingsBlock key={remote.name} className="flex items-center gap-3 py-0">
                {multipleRemotes ? (
                  <button
                    {...remoteGroup.radio(remote.name)}
                    aria-label={`Use ${remote.name} as the primary remote`}
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                  >
                    <RadioDot checked={preferred === remote.name} />
                    <RemoteLabel
                      icon={<ProviderIcon className="size-4 shrink-0 text-muted-foreground" />}
                      name={remote.name}
                      location={remote.ownerRepo ?? remote.url}
                      primary={primary}
                    />
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-3 py-3">
                    <RemoteLabel
                      icon={<ProviderIcon className="size-4 shrink-0 text-muted-foreground" />}
                      name={remote.name}
                      location={remote.ownerRepo ?? remote.url}
                      primary={false}
                    />
                  </div>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Open ${remote.name} in the browser`}
                  onClick={() => openProjectRemote(member, remote.name)}
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Open
                </Button>
              </SettingsBlock>
            );
          })}
        </div>
      )}
    </ProjectSection>
  );
}

function RemoteLabel(props: {
  readonly icon: React.ReactNode;
  readonly name: string;
  readonly location: string;
  readonly primary: boolean;
}) {
  return (
    <>
      {props.icon}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          {props.name}
          {props.primary ? (
            <span className="text-[11px] font-normal text-muted-foreground">primary</span>
          ) : null}
        </span>
        <span
          className="block truncate font-mono text-[11px] text-muted-foreground"
          title={props.location}
        >
          {props.location}
        </span>
      </span>
    </>
  );
}
