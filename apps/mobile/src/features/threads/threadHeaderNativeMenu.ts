import type { MenuAction } from "@react-native-menu/menu";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import {
  flattenThreadHeaderMenu,
  THREAD_HEADER_MORE_ICON,
  THREAD_HEADER_MORE_TITLE,
  type ThreadHeaderMenuAction,
  type ThreadHeaderMenuActionId,
  type ThreadHeaderMenuSection,
} from "./threadHeaderMenuModel";

/**
 * The thread header's ⋯ menu (`buildThreadHeaderMenu`) in each platform's native form: iOS
 * header items with inline or collapsed groups, Android one flat list.
 */

function nativeMenuItem(
  action: ThreadHeaderMenuAction,
  runMenuAction: (id: ThreadHeaderMenuActionId) => void,
) {
  return {
    type: "action" as const,
    label: action.title,
    icon: { type: "sfSymbol" as const, name: action.icon as never },
    ...(action.subtitle ? { description: action.subtitle } : {}),
    disabled: action.disabled ?? false,
    destructive: action.destructive ?? false,
    onPress: () => runMenuAction(action.id),
  };
}

/** The iOS header's right items: one ⋯ menu, a submenu per group. */
export function iosThreadHeaderRightItems(
  headerMenu: ReadonlyArray<ThreadHeaderMenuSection>,
  runMenuAction: (id: ThreadHeaderMenuActionId) => void,
): NativeStackHeaderItem[] {
  return [
    {
      type: "menu",
      label: "",
      accessibilityLabel: "More chat actions",
      icon: { type: "sfSymbol", name: "ellipsis" },
      menu: {
        items: headerMenu.map((section) => ({
          type: "submenu" as const,
          label: section.collapsed?.title ?? "",
          ...(section.collapsed
            ? {
                icon: {
                  type: "sfSymbol" as const,
                  name: section.collapsed.icon as never,
                },
              }
            : { inline: true }),
          items: [
            ...section.actions.map((action) => nativeMenuItem(action, runMenuAction)),
            ...(section.more && section.more.length > 0
              ? [
                  {
                    type: "submenu" as const,
                    label: THREAD_HEADER_MORE_TITLE,
                    icon: {
                      type: "sfSymbol" as const,
                      name: THREAD_HEADER_MORE_ICON as never,
                    },
                    items: section.more.map((action) => nativeMenuItem(action, runMenuAction)),
                  },
                ]
              : []),
          ],
        })),
      },
    },
  ];
}

function androidMenuAction(action: ThreadHeaderMenuAction): MenuAction {
  return {
    id: action.id,
    title: action.title,
    ...(action.subtitle ? { subtitle: action.subtitle } : {}),
    attributes: {
      disabled: action.disabled ?? false,
      destructive: action.destructive ?? false,
    },
  };
}

/** One flat list: Android draws each inline group as an untitled submenu. */
export function androidThreadHeaderMenuActions(
  headerMenu: ReadonlyArray<ThreadHeaderMenuSection>,
): MenuAction[] {
  return flattenThreadHeaderMenu(headerMenu).map(androidMenuAction);
}
