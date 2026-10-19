import type { LocalTaskLink } from "@ryco/contracts";
import {
  CircleDotIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LinkIcon,
  MessageSquareIcon,
} from "lucide-react";

import { AtlassianJiraIcon } from "../Icons";

/** The icon a link shows with, in the meta line and on its chip. */
export function TaskLinkIcon(props: {
  readonly kind: LocalTaskLink["kind"];
  readonly className: string;
}) {
  switch (props.kind) {
    case "pr":
      return <GitPullRequestIcon className={props.className} aria-hidden />;
    case "issue":
      return <CircleDotIcon className={props.className} aria-hidden />;
    case "workItem":
      return <AtlassianJiraIcon className={props.className} aria-hidden />;
    case "branch":
      return <GitBranchIcon className={props.className} aria-hidden />;
    case "thread":
      return <MessageSquareIcon className={props.className} aria-hidden />;
    case "url":
      return <LinkIcon className={props.className} aria-hidden />;
  }
}
