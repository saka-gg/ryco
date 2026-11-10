import {
  peekProjectIconSource,
  projectIconRequestKey,
  readProjectIconSource,
} from "@ryco/client-runtime/connection";
import { useEnvironmentApi } from "../connection/useEnvironmentApi";
import { useEnvironmentServerConfigs } from "../state/environmentServerConfigs";
import {
  loadSavedProjectIcon,
  peekSavedProjectIcon,
  saveProjectIcon,
} from "../rpc/savedProjectIcons";
import { useWsConnectionStatusForEnvironment } from "../rpc/wsConnectionState";
import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  /** Shown while there is no artwork, instead of the folder glyph. */
  readonly fallback?: ReactNode;
  /** Corner radius of the artwork; a sixth of its size by default. */
  readonly radius?: number;
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
  // the icon never depends on the cache entry still being there at render time:
  // once the LRU drops the entry, the row keeps its icon.
  const [artwork, setArtwork] = useState<LatchedArtwork | null>(() => {
    const source = projectId
      ? (peekProjectIconSource(environmentId, projectId, revision) ??
        peekSavedProjectIcon(environmentId, projectId, revision))
      : undefined;
    return source === undefined ? null : { key: requestKey, source };
  });
  const known = artwork?.key === requestKey;
  // The artwork kept on this device shows on a cold start, before (or without) the node.
  useEffect(() => {
    if (!projectId || known) return;
    let current = true;
    void loadSavedProjectIcon(environmentId, projectId, revision).then((source) => {
      if (!current || source === undefined) return;
      setArtwork((latched) =>
        latched?.key === requestKey ? latched : { key: requestKey, source },
      );
    });
    return () => {
      current = false;
    };
  }, [environmentId, known, projectId, requestKey, revision]);
  // A custom avatar's revision names its content: artwork known for it is never read again.
  const settled = known && revision !== null;
  useEffect(() => {
    if (!api || !projectId || settled) return;
    // Answered from the cache while its entry is fresh, without a request;
    // otherwise read again, with the latched artwork on screen until the
    // answer replaces it. A read the node could not finish is not an answer:
    // the artwork on screen stays.
    let current = true;
    void readProjectIconSource(api, environmentId, projectId, revision).then(
      (source) => {
        saveProjectIcon(environmentId, projectId, revision, source);
        if (current) setArtwork((latched) => latchArtwork(latched, requestKey, source));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [api, environmentId, projectId, requestKey, revision, settled]);
  // Artwork the node already answered shows whether or not it is connected now:
  // the Hub keeps one node connected at a time, and every other node's rows
  // keep their icons. A row whose inputs just changed shows cached artwork for
  // the new key on its first pass, before the effect latches it.
  const faviconUrl =
    artwork?.key === requestKey
      ? artwork.source
      : projectId
        ? (peekProjectIconSource(environmentId, projectId, revision) ??
          peekSavedProjectIcon(environmentId, projectId, revision) ??
          null)
        : null;

  return (
    <ProjectFaviconImage
      key={faviconUrl ?? "fallback"}
      cacheKey={requestKey}
      faviconUrl={faviconUrl}
      open={props.open}
      projectTitle={props.projectTitle}
      size={size}
      fallback={props.fallback}
      radius={props.radius}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly cacheKey: string;
  readonly faviconUrl: string | null;
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
  readonly fallback?: ReactNode;
  readonly radius?: number | undefined;
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
      {!showImage && props.fallback !== undefined ? props.fallback : null}
      {!showImage && props.fallback === undefined ? (
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
          // Decoded once per row identity; never kept on disk by expo-image (it
          // cannot be cleared per node): the device copy is the saved store's.
          source={{
            uri: props.faviconUrl,
            cacheKey: props.cacheKey,
          }}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.radius ?? props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          cachePolicy="memory"
          onLoad={() => {
            setStatus("loaded");
          }}
          onError={() => setStatus("error")}
        />
      ) : null}
    </View>
  );
}
