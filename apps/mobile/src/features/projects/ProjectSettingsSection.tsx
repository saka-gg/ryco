import type { ProjectSection } from "@ryco/client-runtime/projectSettings/sections";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import { projectSectionLabel } from "./projectSettingsModel";

/**
 * One section of a project's settings: the grouped-list card the phone's settings use, titled as
 * on the web, with an optional footer that explains it, iOS-style, under the card.
 */
export function ProjectSettingsSection(props: {
  readonly section: ProjectSection;
  readonly footer?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <View>
      <SettingsSection title={projectSectionLabel(props.section)}>{props.children}</SettingsSection>
      {props.footer ? (
        <Text className="px-6 pt-2 font-sans text-xs leading-4 text-foreground-muted">
          {props.footer}
        </Text>
      ) : null}
    </View>
  );
}

/** A line inside a section's card: why something failed, or a quiet note. */
export function SectionMessage(props: {
  readonly message: string;
  readonly tone?: "danger" | "muted";
}) {
  return (
    <View className="border-t border-border-subtle px-5 py-3">
      <Text
        accessibilityRole={props.tone === "danger" ? "alert" : undefined}
        className={`text-sm ${props.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted"}`}
      >
        {props.message}
      </Text>
    </View>
  );
}
