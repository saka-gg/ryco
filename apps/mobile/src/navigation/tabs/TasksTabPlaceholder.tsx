import { ScrollView, View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { MAIN_TABS } from "./mainTabsModel";
import { TabLargeTitle, useLargeTitleCollapse, useTabStackHeader } from "./TabScreenChrome";

/**
 * The Tasks tab until the phone's Tasks screen lands (`features/tasks`'s
 * `TasksTabScreen` replaces this in `lazyRouteScreens.ts`).
 */
export function TasksTabScreen() {
  const { collapsed, onScroll } = useLargeTitleCollapse();
  useTabStackHeader({ title: collapsed ? MAIN_TABS.Tasks.title : "" });
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <TabLargeTitle title={MAIN_TABS.Tasks.title} />
      <View className="px-4 pt-8">
        <EmptyState
          variant="plain"
          title="Tasks are coming to the phone"
          detail="Your Ryco task list from the desktop and web Tasks page will show here."
        />
      </View>
    </ScrollView>
  );
}
