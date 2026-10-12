import {
  peekProjectIconSource,
  projectIconRequestKey,
  readProjectIconSource,
} from "@ryco/client-runtime/connection";
import { readEnvironmentApi } from "../connection/environmentApi";
import { useEnvironmentServerConfigs } from "../state/environmentServerConfigs";
import { useWsConnectionStatusForEnvironment } from "../rpc/wsConnectionState";
import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useThemeColor } from "../lib/useThemeColor";

export function ProjectFavicon(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly customAvatarContentHash?: string | null;
  readonly open?: boolean;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
}) {
  const size = props.size ?? 42;
  const configs = useEnvironmentServerConfigs();
  const connectionPhase = useWsConnectionStatusForEnvironment(props.environmentId).phase;
  const config = configs.get(props.environmentId);
  const api =
    connectionPhase === "connected" && config?.environment.capabilities.projectIcons
      ? readEnvironmentApi(props.environmentId)
      : undefined;
  const projectId = props.projectId;
  const environmentId = props.environmentId;
  const revision = props.customAvatarContentHash ?? null;
  // Keyed by environment + project + avatar revision, not the connection:
  // foreground reconnects and remounts reuse artwork already read.
  const requestKey = useMemo(
    () => projectIconRequestKey(environmentId, projectId, revision),
    [environmentId, projectId, revision],
  );
  const [artwork, setArtwork] = useState<{ key: string; source: string | null } | null>(null);
  const cached =
    api && projectId ? peekProjectIconSource(environmentId, projectId, revision) : undefined;
  useEffect(() => {
    if (!api || !projectId) return;
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
  }, [api, environmentId, projectId, requestKey, revision]);
  const faviconUrl = api ? (artwork?.key === requestKey ? artwork.source : (cached ?? null)) : null;

  return (
    <ProjectFaviconImage
      key={faviconUrl ?? "fallback"}
      faviconUrl={faviconUrl}
      open={props.open}
      projectTitle={props.projectTitle}
      size={size}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly faviconUrl: string | null;
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const iconMuted = useThemeColor("--color-icon-subtle");

  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const showImage = props.faviconUrl !== null && status === "loaded";

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Folder icon fallback (matches web's FolderIcon) */}
      {!showImage ? (
        <SymbolView
          name={{ ios: "folder.fill", android: props.open ? "folder_open" : "folder" }}
          size={props.size * 0.78}
          tintColor={iconMuted}
          type="monochrome"
        />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {props.faviconUrl ? (
        <Image
          source={{
            uri: props.faviconUrl,
          }}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          cachePolicy="none"
          onLoad={() => {
            setStatus("loaded");
          }}
          onError={() => setStatus("error")}
        />
      ) : null}
    </View>
  );
}
