import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { View } from "react-native";

import { projectBadgeColor, projectBadgeInitial } from "../lib/projectBadge";
import { AppText as Text } from "./AppText";
import { ProjectFavicon } from "./ProjectFavicon";

/**
 * A project's colored badge: its own icon when it has one, else its initial on its stable
 * color (the title pill and the chat's context card).
 */
export function ProjectBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly customAvatarContentHash: string | null;
  readonly name: string;
  readonly size: number;
}) {
  // The prototype's badge: 7pt corners and a small bold initial at every size.
  const radius = 7;
  const initial = (
    <View
      className="items-center justify-center"
      style={{
        width: props.size,
        height: props.size,
        borderRadius: radius,
        backgroundColor: projectBadgeColor(props.projectId ?? props.name),
      }}
    >
      <Text
        className="font-ryco-bold text-white"
        style={{
          fontSize: Math.round(props.size * 0.42),
          lineHeight: Math.round(props.size * 0.6),
        }}
        allowFontScaling={false}
      >
        {projectBadgeInitial(props.name)}
      </Text>
    </View>
  );
  if (props.projectId === null) return initial;
  return (
    <ProjectFavicon
      environmentId={props.environmentId}
      projectId={props.projectId}
      customAvatarContentHash={props.customAvatarContentHash}
      projectTitle={props.name}
      size={props.size}
      radius={radius}
      fallback={initial}
    />
  );
}
