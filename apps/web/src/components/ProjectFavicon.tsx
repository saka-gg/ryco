import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";
import { isHostedHubMode } from "../env";
import { useAtomValue } from "@effect/atom-react";
import { serverConfigAtom, wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { readEnvironmentApi } from "../environmentApi";
import { readProjectIconSource } from "./projectIconSource";
import { cn } from "../lib/utils";

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  projectId?: ProjectId;
  customAvatarContentHash?: string | null;
  className?: string;
  fillContainer?: boolean;
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
    source: string | null;
  } | null>(null);
  useEffect(() => {
    let current = true;
    if (api && projectId) {
      void readProjectIconSource(api, projectId, revision, connection.connectedAt)
        .then((source) => {
          if (current) setArtwork({ key: requestKey, api, source });
        })
        .catch(() => {
          if (current) setArtwork({ key: requestKey, api, source: null });
        });
    }
    return () => {
      current = false;
    };
  }, [api, projectId, revision, requestKey, connection.connectedAt]);
  const src = (() => {
    if (rpcSupported && projectId)
      return artwork?.key === requestKey && artwork.api === api && api ? artwork.source : null;
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
    />
  );
}

function ProjectFaviconImage(input: {
  src: string | null;
  className?: string | undefined;
  fillContainer?: boolean | undefined;
}) {
  const { src } = input;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const fallbackClass = input.fillContainer
    ? cn("size-full text-muted-foreground/50", input.className)
    : cn("size-3.5 shrink-0 text-muted-foreground/50", input.className);

  if (!src || status === "error") {
    return <FolderIcon className={fallbackClass} />;
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
      {status !== "loaded" ? <FolderIcon className={fallbackClass} /> : null}
      <img
        src={src}
        alt=""
        className={imgClass}
        onLoad={() => {
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
