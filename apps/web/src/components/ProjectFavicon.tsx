import type { EnvironmentId, ProjectId, ServerConfig } from "@ryco/contracts";
import { FolderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";
import { isHostedHubMode } from "../env";
import { useAtomValue } from "@effect/atom-react";
import { wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { readEnvironmentApi } from "../environmentApi";
import { usePrimaryServerConfigSelector } from "../rpc/serverState";
import {
  peekProjectIconSource,
  projectIconRequestKey,
  readProjectIconSource,
} from "./projectIconSource";
import { deriveProjectMonogram } from "./projectMonogram";
import { useHasIntersectedViewport } from "./sidebar/hooks/useHasIntersectedViewport";
import { cn } from "../lib/utils";

/** Older servers without the icon RPC serve the favicon over HTTP. */
function resolveProjectFaviconHttpUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectId: ProjectId | undefined;
  readonly customAvatarContentHash: string | null;
}): string | null {
  try {
    if (input.customAvatarContentHash && input.projectId) {
      return resolveEnvironmentHttpUrl({
        environmentId: input.environmentId,
        pathname: "/api/project-avatar",
        searchParams: { projectId: input.projectId, v: input.customAvatarContentHash },
      });
    }
    return resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: "/api/project-favicon",
      searchParams: { cwd: input.cwd },
    });
  } catch {
    return null;
  }
}

/**
 * The primary node's icon capability as a primitive: `null` while its config is
 * unknown. Rows subscribe to this, not to the whole config, so provider and
 * settings pushes do not re-render every favicon.
 */
const selectProjectIconsSupport = (config: ServerConfig | null): boolean | null =>
  config === null ? null : config.environment.capabilities.projectIcons === true;

/**
 * How long a row waits before asking again after the node could not answer
 * (stalled or unavailable read). The first delay matches the node's own
 * back-off for a stalled root; each later one doubles. Once these are used up
 * the row stops asking until its read runs again (reconnect, remount or a new
 * avatar revision), so a root that always stalls does not cost the node a
 * reader child every minute for as long as the row is on screen.
 */
const PROJECT_ICON_RETRY_DELAYS_MS = [60_000, 120_000, 240_000] as const;

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  projectId?: ProjectId;
  customAvatarContentHash?: string | null;
  className?: string;
  fillContainer?: boolean;
  /** Without artwork, show this name's colored initials instead of a folder. */
  fallbackName?: string;
  /** Called with the artwork once it has loaded, e.g. to measure it for framing. */
  onImageLoad?: (image: HTMLImageElement) => void;
  /**
   * Hold the artwork request (show the fallback) until this turns false, e.g.
   * while a long list row has not come near the viewport yet.
   */
  deferred?: boolean;
}) {
  const primaryId = usePrimaryEnvironmentId();
  const primarySupport = usePrimaryServerConfigSelector(selectProjectIconsSupport);
  const savedSupport = useSavedEnvironmentRuntimeStore((state) => {
    const config = state.byId[input.environmentId]?.serverConfig;
    return config == null ? null : selectProjectIconsSupport(config);
  });
  const connectionPhase = useAtomValue(
    wsConnectionStatusForEnvironmentAtom(input.environmentId),
  ).phase;
  const iconSupport = input.environmentId === primaryId ? primarySupport : savedSupport;
  const rpcSupported = iconSupport === true;
  const deferred = input.deferred === true;
  const api =
    connectionPhase === "connected" && rpcSupported && !deferred
      ? readEnvironmentApi(input.environmentId)
      : undefined;
  const projectId = input.projectId;
  const environmentId = input.environmentId;
  const revision = input.customAvatarContentHash ?? null;
  // An icon is read once it is (nearly) on screen: a long project list or a
  // collapsed folder no longer asks the node for every project's artwork.
  const [setVisibilityNode, visible] = useHasIntersectedViewport();
  // Keyed by environment + project + avatar revision, not the connection:
  // reconnects and remounts reuse artwork already read.
  const requestKey = useMemo(
    () => projectIconRequestKey(environmentId, projectId, revision),
    [environmentId, projectId, revision],
  );
  // The artwork this row shows, latched: once displayed it stays until a newer
  // answer replaces it, so an evicted cache entry never blanks a mounted row.
  const [artwork, setArtwork] = useState<{ key: string; source: string | null } | null>(null);
  // Artwork the node already answered renders on the first pass, without a
  // request, and whether or not the node is connected now: the Hub keeps one
  // node connected at a time, and every other node's rows keep their icons.
  const known = projectId
    ? artwork?.key === requestKey
      ? artwork.source
      : peekProjectIconSource(environmentId, projectId, revision)
    : undefined;
  useEffect(() => {
    if (!api || !projectId || !visible) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A fresh cache hit answers without a request; an expired entry is read
    // again while the known artwork stays on screen (stale-while-revalidate).
    // Answers are revalidated only when this effect runs again, never on a
    // free-running timer. A read the node could not finish is not an answer:
    // the known artwork stays, and the read is retried a bounded number of times.
    const readArtwork = (failures: number) => {
      if (!current) return;
      readProjectIconSource(api, environmentId, projectId, revision).then(
        (source) => {
          if (!current) return;
          setArtwork((previous) => latchArtwork(previous, requestKey, source));
        },
        () => {
          if (!current) return;
          const delay = PROJECT_ICON_RETRY_DELAYS_MS[failures];
          if (delay !== undefined) timer = setTimeout(() => readArtwork(failures + 1), delay);
        },
      );
    };
    readArtwork(0);
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, environmentId, projectId, requestKey, revision, visible]);
  // Until the node's config is known, whether it serves icons over RPC is
  // unknown: show known artwork or the placeholder rather than starting an HTTP
  // fallback the RPC would duplicate a moment later.
  const src = deferred
    ? null
    : projectId && iconSupport !== false
      ? (known ?? null)
      : iconSupport === null || isHostedHubMode() || !visible
        ? null
        : resolveProjectFaviconHttpUrl({
            environmentId,
            cwd: input.cwd,
            projectId,
            customAvatarContentHash: revision,
          });
  return (
    <ProjectFaviconImage
      key={src ?? "fallback"}
      src={src}
      observeVisibility={setVisibilityNode}
      className={input.className}
      fillContainer={input.fillContainer}
      fallbackName={input.fallbackName}
      onImageLoad={input.onImageLoad}
    />
  );
}

function latchArtwork(
  previous: { key: string; source: string | null } | null,
  key: string,
  source: string | null,
): { key: string; source: string | null } {
  return previous?.key === key && previous.source === source ? previous : { key, source };
}

function ProjectFaviconImage(input: {
  src: string | null;
  /** Callback ref observing whichever element is on screen, to start the icon read. */
  observeVisibility: (node: Element | null) => void;
  className?: string | undefined;
  fillContainer?: boolean | undefined;
  fallbackName?: string | undefined;
  onImageLoad?: ((image: HTMLImageElement) => void) | undefined;
}) {
  const { src, observeVisibility, className, fillContainer, fallbackName, onImageLoad } = input;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const fallbackOnly = !src || status === "error";

  const fallbackClass = fillContainer
    ? cn("size-full text-muted-foreground/50", className)
    : cn("size-3.5 shrink-0 text-muted-foreground/50", className);
  // Alone, the fallback is what is on screen; beside a loading image it is not observed.
  const fallbackObserver = fallbackOnly ? observeVisibility : undefined;

  const fallback =
    fallbackName === undefined ? (
      <FolderIcon ref={fallbackObserver} className={fallbackClass} />
    ) : (
      <ProjectMonogram
        observe={fallbackObserver}
        name={fallbackName}
        className={fillContainer ? cn("size-full", className) : cn("size-3.5", className)}
      />
    );

  if (fallbackOnly) {
    return fallback;
  }

  const imgClass = fillContainer
    ? cn("size-full object-cover", status === "loaded" ? "" : "hidden", className)
    : cn(
        "size-3.5 shrink-0 rounded-sm object-contain",
        status === "loaded" ? "" : "hidden",
        className,
      );

  return (
    <>
      {status !== "loaded" ? fallback : null}
      <img
        ref={observeVisibility}
        src={src}
        alt=""
        className={imgClass}
        data-state={status}
        onLoad={(event) => {
          setStatus("loaded");
          onImageLoad?.(event.currentTarget);
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}

/** Colored initials on a rounded square; scales with its size class. */
export function ProjectMonogram(input: {
  name: string;
  className?: string | undefined;
  /** Callback ref for the rendered element. */
  observe?: ((node: Element | null) => void) | undefined;
}) {
  const { name, className, observe } = input;
  const { initials, color } = useMemo(() => deriveProjectMonogram(name), [name]);
  return (
    <svg
      ref={observe}
      viewBox="0 0 16 16"
      className={cn("size-3.5 shrink-0", className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="16" height="16" rx="4" fill={color} />
      <text
        x="8"
        y="8.5"
        dominantBaseline="central"
        textAnchor="middle"
        fill="white"
        fontSize={initials.length > 1 ? 7 : 9}
        fontWeight={600}
        letterSpacing={initials.length > 1 ? -0.2 : 0}
        className="font-sans select-none"
      >
        {initials}
      </text>
    </svg>
  );
}
