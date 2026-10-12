import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { FolderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";
import { isHostedHubMode } from "../env";
import { useAtomValue } from "@effect/atom-react";
import { serverConfigAtom, wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { readEnvironmentApi } from "../environmentApi";
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
  const primaryConfig = useAtomValue(serverConfigAtom);
  const savedConfig = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[input.environmentId]?.serverConfig,
  );
  const connectionPhase = useAtomValue(
    wsConnectionStatusForEnvironmentAtom(input.environmentId),
  ).phase;
  const config = input.environmentId === primaryId ? primaryConfig : savedConfig;
  const rpcSupported = config?.environment.capabilities.projectIcons === true;
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
  const [artwork, setArtwork] = useState<{ key: string; source: string | null } | null>(null);
  // Cached artwork renders on the first pass, without a request.
  const cached =
    api && projectId ? peekProjectIconSource(environmentId, projectId, revision) : undefined;
  useEffect(() => {
    if (!api || !projectId || !visible) return;
    if (peekProjectIconSource(environmentId, projectId, revision) !== undefined) return;
    let current = true;
    void readProjectIconSource(api, environmentId, projectId, revision)
      .then((source) => {
        if (current) setArtwork({ key: requestKey, source });
      })
      .catch(() => {
        if (current) setArtwork({ key: requestKey, source: null });
      });
    return () => {
      current = false;
    };
  }, [api, environmentId, projectId, requestKey, revision, visible]);
  const src =
    // Until the node's config is known, whether it serves icons over RPC is
    // unknown: show the placeholder rather than starting an HTTP fallback the
    // RPC would duplicate a moment later.
    config == null || deferred
      ? null
      : rpcSupported && projectId
        ? // Node artwork shows only while the node is connected.
          api
          ? artwork?.key === requestKey
            ? artwork.source
            : (cached ?? null)
          : null
        : isHostedHubMode() || !visible
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
