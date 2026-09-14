import { readProjectIconSource } from "@ryco/client-runtime/connection";
import { readEnvironmentApi } from "../connection/environmentApi";
import { useEnvironmentServerConfigs } from "../state/environmentServerConfigs";
import { useWsConnectionStatusForEnvironment } from "../rpc/wsConnectionState";
import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useEffect, useState } from "react";
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
  const connection = useWsConnectionStatusForEnvironment(props.environmentId);
  const api =
    connection.phase === "connected" &&
    configs.get(props.environmentId)?.environment.capabilities.projectIcons
      ? readEnvironmentApi(props.environmentId)
      : undefined;
  const projectId = props.projectId;
  const revision = props.customAvatarContentHash ?? null;
  const requestKey = JSON.stringify([
    props.environmentId,
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
  const faviconUrl =
    api && artwork?.key === requestKey && artwork.api === api && artwork.connection === connection
      ? artwork.source
      : null;

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
