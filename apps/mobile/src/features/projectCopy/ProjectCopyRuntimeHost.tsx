import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { useThemeColor } from "../../lib/useThemeColor";
import { HOME_TOOLBAR_HEIGHT, HOME_TOOLBAR_INSET } from "../home/homeChromeModel";
import { copyNoticeLinkPath, copyNoticeTone } from "./copyNoticeModel";
import {
  dismissProjectCopyNotice,
  readProjectCopyEntry,
  readProjectCopyRecord,
  registerProjectCopyNavigation,
  registerProjectCopyViewer,
  resumeProjectCopies,
  useProjectCopyNotice,
} from "./mobileCopyManager";
import { useMobileNodeCatalog, usePublishMobileNodeCatalog } from "./mobileNodeCatalog";
import { startMobileNodeDirectoryPublisher } from "./mobileNodeDirectoryPublisher";

/** How long a finished copy's notice stays before it goes by itself. */
const RESULT_NOTICE_MS = 8_000;

function openPath(path: string, queryParams?: Record<string, string>): void {
  void Linking.openURL(Linking.createURL(path, queryParams ? { queryParams } : undefined));
}

/**
 * Keeps the phone's copies running outside the copy screen: publishes the
 * node catalog (and the node directory agents copy with), picks up copies a previous launch left (and reports what
 * Agent Control copies owe), lets the copy manager open the copy screen and a
 * copied project, and shows the one copy notice. Mounted once, at the root.
 */
export function ProjectCopyRuntimeHost() {
  usePublishMobileNodeCatalog();
  const catalog = useMobileNodeCatalog();
  const hasNodes = catalog.nodes.length > 0;
  const [resumed, setResumed] = useState(false);

  useEffect(() => {
    if (!hasNodes || resumed) return;
    setResumed(true);
    void resumeProjectCopies().catch((error: unknown) => {
      console.warn("Resuming project copies failed.", error);
    });
  }, [hasNodes, resumed]);

  // Agents on the machines this phone owns learn which machines they may copy to.
  useEffect(() => startMobileNodeDirectoryPublisher(), []);

  useEffect(() => {
    const stopNavigation = registerProjectCopyNavigation({
      openCopy: (copyId) => {
        const path = copyNoticeLinkPath(
          readProjectCopyRecord(copyId),
          readProjectCopyEntry(copyId),
        );
        if (path !== null) openPath(path, { copyId });
      },
      openStopped: (request) =>
        openPath(`projects/${request.environmentId}/${request.projectId}/copy`, {
          resumeCopyId: request.copyId,
        }),
    });
    const stopViewer = registerProjectCopyViewer((ref) =>
      openPath(`projects/${ref.environmentId}/${ref.projectId}`),
    );
    return () => {
      stopNavigation();
      stopViewer();
    };
  }, []);

  return <ProjectCopyNoticeHost />;
}

function ProjectCopyNoticeHost() {
  const notice = useProjectCopyNotice();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const kind = notice?.kind ?? null;
  const copyId = notice?.copyId ?? null;
  useEffect(() => {
    if (kind !== "result" || copyId === null) return;
    const timer = setTimeout(dismissProjectCopyNotice, RESULT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copyId, kind]);
  if (notice === null) return null;
  const tone = copyNoticeTone(notice);
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-4 right-4"
      style={{ bottom: insets.bottom + HOME_TOOLBAR_INSET + HOME_TOOLBAR_HEIGHT + 8 }}
    >
      <Animated.View
        key={`${notice.copyId}:${notice.kind}`}
        entering={FadeInDown.duration(220).reduceMotion(ReduceMotion.System)}
        exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
      >
        <GlassSurface radius={28} style={{ borderRadius: 28 }}>
          <View
            accessibilityLiveRegion="polite"
            className="min-h-12 flex-row items-center gap-3 py-1.5 pl-4 pr-1.5"
          >
            <SymbolView name={tone.symbol} size={20} tintColor={iconColor} />
            <View className="min-w-0 flex-1">
              <AppText className="font-ryco-medium text-sm" numberOfLines={1}>
                {notice.view.title}
              </AppText>
              <AppText className="text-xs text-foreground-muted" numberOfLines={1}>
                {tone.detail}
              </AppText>
            </View>
            {notice.secondary ? (
              <Pressable
                accessibilityRole="button"
                onPress={notice.secondary.run}
                className="min-h-11 items-center justify-center rounded-full px-3 active:opacity-70"
              >
                <AppText className="font-ryco-medium text-sm text-foreground-muted">
                  {notice.secondary.label}
                </AppText>
              </Pressable>
            ) : null}
            {notice.primary ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  notice.primary?.run();
                  if (notice.kind !== "progress") dismissProjectCopyNotice();
                }}
                className="min-h-11 min-w-16 items-center justify-center rounded-full bg-subtle-strong px-4 active:opacity-70"
              >
                <AppText className="font-ryco-medium text-sm">{notice.primary.label}</AppText>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
                onPress={dismissProjectCopyNotice}
                className="min-h-11 min-w-11 items-center justify-center rounded-full active:opacity-70"
              >
                <SymbolView name="xmark" size={14} tintColor={iconColor} />
              </Pressable>
            )}
          </View>
        </GlassSurface>
      </Animated.View>
    </View>
  );
}
