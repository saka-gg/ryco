import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  isProposedPlanCollapsible,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "@ryco/client-runtime/state/composer";
import type { ProposedPlan } from "@ryco/client-runtime/state/threads";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { openWebLink } from "../../lib/openWebLink";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useNativeMarkdownTextStyle } from "../../native/useNativeMarkdownTextStyle";
import { proposedPlanPresentation } from "./threadPresentation";

/** What a plan's buttons do; the screen owns the sending (`proposedPlanActions.ts`). */
export interface ProposedPlanCardActions {
  readonly implement: (plan: ProposedPlan) => void;
  readonly implementInNewThread: (plan: ProposedPlan) => void;
  readonly copy: (plan: ProposedPlan) => void;
  readonly save: (plan: ProposedPlan) => void;
  readonly share: (plan: ProposedPlan) => void;
}

type PlanMenuId = "implement-new" | "copy" | "save" | "share";

function menuActions(actionable: boolean): MenuAction[] {
  return [
    ...(actionable
      ? [{ id: "implement-new", title: "Implement in a new chat", image: "plus.bubble" }]
      : []),
    { id: "copy", title: "Copy as Markdown", image: "doc.on.doc" },
    { id: "save", title: "Save to workspace…", image: "square.and.arrow.down" },
    { id: "share", title: "Share…", image: "square.and.arrow.up" },
  ];
}

/**
 * A plan the agent proposed: its title, the plan folded to a preview when it is long, and, on the
 * plan that can be carried out now, Implement (here) with the rarer actions behind ⋯.
 */
export function ProposedPlanCard(props: {
  readonly plan: ProposedPlan;
  /** The settled latest turn's plan that nobody implemented yet: Implement is offered. */
  readonly actionable: boolean;
  readonly actions: ProposedPlanCardActions | undefined;
}) {
  const { plan, actions } = props;
  const presentation = proposedPlanPresentation();
  const markdownStyle = useNativeMarkdownTextStyle();
  const iconColor = useThemeColor("--color-icon");
  const collapsible = isProposedPlanCollapsible(plan.planMarkdown);
  const [expanded, setExpanded] = useState(false);
  const title = proposedPlanTitle(plan.planMarkdown);
  const body =
    collapsible && !expanded
      ? buildCollapsedProposedPlanPreviewMarkdown(plan.planMarkdown)
      : stripDisplayedPlanMarkdown(plan.planMarkdown);
  const onMenu = ({ nativeEvent }: NativeActionEvent) => {
    if (!actions) return;
    switch (nativeEvent.event as PlanMenuId) {
      case "implement-new":
        return actions.implementInNewThread(plan);
      case "copy":
        return actions.copy(plan);
      case "save":
        return actions.save(plan);
      case "share":
        return actions.share(plan);
    }
  };

  return (
    <View className={`mx-4 my-2 gap-2 rounded-2xl p-4 ${presentation.containerClassName}`}>
      <View className="flex-row items-center gap-2">
        <Text
          className={`text-xs font-ryco-bold uppercase tracking-wide ${presentation.labelClassName}`}
        >
          Plan
        </Text>
        {plan.implementedAt !== null ? (
          <View className="flex-row items-center gap-1">
            <SymbolView name="checkmark" size={10} tintColor={iconColor} type="monochrome" />
            <Text className="text-xs text-foreground-muted">Implemented</Text>
          </View>
        ) : null}
        <View className="flex-1" />
        {actions ? (
          <MenuView actions={menuActions(props.actionable)} onPressAction={onMenu}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="More plan actions"
              hitSlop={8}
              className="h-7 w-7 items-center justify-center rounded-full active:bg-subtle"
            >
              <SymbolView name="ellipsis" size={15} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </MenuView>
        ) : null}
      </View>
      {title ? (
        <Text className="text-base font-ryco-bold text-foreground" selectable>
          {title}
        </Text>
      ) : null}
      {hasNativeSelectableMarkdownText() ? (
        <SelectableMarkdownText
          markdown={body}
          textStyle={markdownStyle}
          preserveSoftBreaks
          marginTop={0}
          marginBottom={0}
          onLinkPress={openWebLink}
        />
      ) : (
        <Text className="font-sans text-sm text-foreground" selectable>
          {body}
        </Text>
      )}
      {collapsible ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((value) => !value)}
          hitSlop={6}
          className="self-start active:opacity-60"
        >
          <Text className="text-xs font-ryco-medium text-foreground-muted">
            {expanded ? "Show less" : "Show full plan"}
          </Text>
        </Pressable>
      ) : null}
      {props.actionable && actions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Sends a message that carries out this plan in this chat."
          onPress={() => actions.implement(plan)}
          className="mt-1 h-10 flex-row items-center justify-center gap-2 self-start rounded-full bg-primary px-5 active:opacity-80"
        >
          <Text className="text-sm font-ryco-bold text-primary-foreground">Implement</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
