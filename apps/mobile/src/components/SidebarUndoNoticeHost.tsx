import { useEffect, useSyncExternalStore } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sidebarUndo, sidebarUndoNotices } from "../state/sidebarUndo";
import { AppText } from "./AppText";

const labels = {
  archive: "Task archived",
  settle: "Task settled",
  snooze: "Task snoozed",
  unpin: "Task unpinned",
};
export function SidebarUndoNoticeHost() {
  const notices = useSyncExternalStore(sidebarUndoNotices.subscribe, sidebarUndoNotices.read);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const newest = notices.at(-1);
    if (newest && !newest.pending && !newest.applying)
      AccessibilityInfo.announceForAccessibility(
        `${labels[newest.action]}${newest.threadTitle ? `: ${newest.threadTitle}` : ""}. Undo available.`,
      );
  }, [notices]);
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-4 right-4 gap-2"
      style={{ bottom: insets.bottom + 16 }}
    >
      {notices.map((notice) => (
        <View
          key={notice.id}
          accessibilityLiveRegion="polite"
          className="flex-row items-center rounded-2xl bg-card px-4 py-2"
        >
          <AppText numberOfLines={2} className="flex-1 text-sm">
            {notice.applying ? "Updating task…" : labels[notice.action]}
            {notice.threadTitle ? `: ${notice.threadTitle}` : ""}
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Undo ${notice.action}${notice.threadTitle ? ` ${notice.threadTitle}` : ""}`}
            accessibilityState={{ disabled: notice.pending }}
            disabled={notice.pending}
            className="min-h-11 min-w-16 items-center justify-center"
            onPress={() => void sidebarUndo.undo(notice.id)}
          >
            <AppText className="text-sm font-ryco-medium">
              {notice.pending ? "Undoing…" : "Undo"}
            </AppText>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
