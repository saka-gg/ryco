import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import { openTaskCapture } from "./taskCaptureStore";

type Navigation = Pick<NavigationProp<ParamListBase>, "navigate">;

const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;

/**
 * "Add to Tasks" from a pull request: fast capture on the pull request's
 * machine and project, the new task linked to it (number, URL and title as
 * they read now). One call for the pull request screen's menu.
 */
export function openTaskCaptureForPullRequest(
  navigation: Navigation,
  pullRequest: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly number: number;
    readonly url?: string | null;
    readonly title?: string | null;
  },
): void {
  const url = pullRequest.url?.trim();
  const title = pullRequest.title?.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
  openTaskCapture({
    environmentId: pullRequest.environmentId,
    projectId: pullRequest.projectId,
    link: {
      kind: "pr",
      number: pullRequest.number,
      ...(url && url.length <= MAX_URL_LENGTH && /^https?:\/\/\S+$/i.test(url) ? { url } : {}),
      ...(title ? { title } : {}),
    },
    linkLabel: title ? `#${pullRequest.number} ${title}` : `Pull request #${pullRequest.number}`,
    openDetails: (environmentId, taskId) =>
      navigation.navigate("TaskDetail", { environmentId, taskId }),
  });
}
