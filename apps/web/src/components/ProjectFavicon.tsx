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
import { readProjectIconSource } from "./projectIconSource";
import { deriveProjectMonogram } from "./projectMonogram";
import { cn } from "../lib/utils";

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
}) {
  const primaryId = usePrimaryEnvironmentId();
  const primaryConfig = useAtomValue(serverConfigAtom);
  const savedConfig = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[input.environmentId]?.serverConfig,
  );
  const connection = useAtomValue(wsConnectionStatusForEnvironmentAtom(input.environmentId));
  const config = input.environmentId === primaryId ? primaryConfig : savedConfig;
  const rpcSupported = config?.environment.capabilities.projectIcons === true;
  const api =
    connection.phase === "connected" && rpcSupported
      ? readEnvironmentApi(input.environmentId)
      : undefined;
  const projectId = input.projectId;
  const revision = input.customAvatarContentHash ?? null;
  const requestKey = JSON.stringify([
    input.environmentId,
    projectId,
    revision,
    connection.connectedAt,
  ]);
  const [artwork, setArtwork] = useState<{
    key: string;
    api: typeof api;
    connection: typeof connection;
    source: string | null;
  } | null>(null);
  useEffect(() => {
    let current = true;
    if (api && projectId) {
      void readProjectIconSource(api, projectId, revision, connection)
        .then((source) => {
          if (current) setArtwork({ key: requestKey, api, connection, source });
        })
        .catch(() => {
          if (current) setArtwork({ key: requestKey, api, connection, source: null });
        });
    }
    return () => {
      current = false;
    };
  }, [api, projectId, revision, requestKey, connection]);
  const src = (() => {
    if (rpcSupported && projectId)
      return artwork?.key === requestKey &&
        artwork.api === api &&
        artwork.connection === connection &&
        api
        ? artwork.source
        : null;
    if (isHostedHubMode()) return null;
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
  })();
  return (
    <ProjectFaviconImage
      key={src ?? "fallback"}
      src={src}
      className={input.className}
      fillContainer={input.fillContainer}
      fallbackName={input.fallbackName}
      onImageLoad={input.onImageLoad}
    />
  );
}

function ProjectFaviconImage(input: {
  src: string | null;
  className?: string | undefined;
  fillContainer?: boolean | undefined;
  fallbackName?: string | undefined;
  onImageLoad?: ((image: HTMLImageElement) => void) | undefined;
}) {
  const { src } = input;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const fallbackClass = input.fillContainer
    ? cn("size-full text-muted-foreground/50", input.className)
    : cn("size-3.5 shrink-0 text-muted-foreground/50", input.className);

  const fallback =
    input.fallbackName === undefined ? (
      <FolderIcon className={fallbackClass} />
    ) : (
      <ProjectMonogram
        name={input.fallbackName}
        className={
          input.fillContainer ? cn("size-full", input.className) : cn("size-3.5", input.className)
        }
      />
    );

  if (!src || status === "error") {
    return fallback;
  }

  const imgClass = input.fillContainer
    ? cn("size-full object-cover", status === "loaded" ? "" : "hidden", input.className)
    : cn(
        "size-3.5 shrink-0 rounded-sm object-contain",
        status === "loaded" ? "" : "hidden",
        input.className,
      );

  return (
    <>
      {status !== "loaded" ? fallback : null}
      <img
        src={src}
        alt=""
        className={imgClass}
        data-state={status}
        onLoad={(event) => {
          setStatus("loaded");
          input.onImageLoad?.(event.currentTarget);
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}

/** Colored initials on a rounded square; scales with its size class. */
export function ProjectMonogram(input: { name: string; className?: string | undefined }) {
  const { initials, color } = useMemo(() => deriveProjectMonogram(input.name), [input.name]);
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-3.5 shrink-0", input.className)}
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
