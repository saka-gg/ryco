import {
  peekProjectIconSource,
  projectIconRequestKey,
  readProjectIconSource,
} from "@ryco/client-runtime/connection";
import { useEnvironmentApi } from "../connection/useEnvironmentApi";
import { useEnvironmentServerConfigs } from "../state/environmentServerConfigs";
import { useWsConnectionStatusForEnvironment } from "../rpc/wsConnectionState";
import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useThemeColor } from "../lib/useThemeColor";

interface LatchedArtwork {
  readonly key: string;
  readonly source: string | null;
}

/** Keeps the current object when nothing changed, so the latch never re-renders a row. */
function latchArtwork(
  current: LatchedArtwork | null,
  key: string,
  source: string | null,
): LatchedArtwork {
  return current?.key === key && current.source === source ? current : { key, source };
}

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
  // Subscribed to the connection itself, so a replaced client is never read
  // through an api cached from the previous one.
  const environmentApi = useEnvironmentApi(props.environmentId);
  const api =
    connectionPhase === "connected" && config?.environment.capabilities.projectIcons
      ? environmentApi
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
  // The artwork this row shows, latched into state as soon as it is known, so
  // the icon never depends on the cache entry still being fresh at render time:
  // once the TTL passes or the LRU drops the entry, the row keeps its icon.
  const [artwork, setArtwork] = useState<LatchedArtwork | null>(() => {
    const source =
      api && projectId ? peekProjectIconSource(environmentId, projectId, revision) : undefined;
    return source === undefined ? null : { key: requestKey, source };
  });
  useEffect(() => {
    if (!api || !projectId) return;
    // Answered from the cache while its entry is fresh, without a request;
    // otherwise read again, with the latched artwork on screen until the
    // answer replaces it.
    let current = true;
    void readProjectIconSource(api, environmentId, projectId, revision)
      .then((source) => {
        if (current) setArtwork((latched) => latchArtwork(latched, requestKey, source));
      })
      .catch(() => {
        if (current) setArtwork((latched) => latchArtwork(latched, requestKey, null));
      });
    return () => {
      current = false;
    };
  }, [api, environmentId, projectId, requestKey, revision]);
  // A row whose inputs just changed shows cached artwork for the new key on its
  // first pass, before the effect latches it.
  const faviconUrl = api
    ? artwork?.key === requestKey
      ? artwork.source
      : projectId
        ? (peekProjectIconSource(environmentId, projectId, revision) ?? null)
        : null
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
