import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import type { ThreadHeaderMenuActionId } from "./threadHeaderMenuModel";

/** The thread header's ⋯ button on Android, opening its menu (`androidThreadHeaderMenuActions`). */
export function ThreadHeaderMenuButton(props: {
  readonly actions: MenuAction[];
  readonly onAction: (id: ThreadHeaderMenuActionId) => void;
  readonly iconColor: string;
}) {
  return (
    <MenuView
      actions={props.actions}
      onPressAction={({ nativeEvent }: NativeActionEvent) =>
        props.onAction(nativeEvent.event as ThreadHeaderMenuActionId)
      }
    >
      <View
        accessibilityRole="button"
        accessibilityLabel="More chat actions"
        className="h-11 w-11 items-center justify-center rounded-full"
      >
        <SymbolView name="ellipsis" size={21} tintColor={props.iconColor} type="monochrome" />
      </View>
    </MenuView>
  );
}
