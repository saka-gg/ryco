import type { LocalTaskLink } from "@ryco/contracts";
import {
  CircleDotIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LinkIcon,
  MessageSquareIcon,
} from "lucide-react";

/** The icon a link shows with, in the meta line and on its chip; a Jira item reads as an issue. */
export function TaskLinkIcon(props: {
  readonly kind: LocalTaskLink["kind"];
  readonly className: string;
}) {
  switch (props.kind) {
    case "pr":
      return <GitPullRequestIcon className={props.className} aria-hidden />;
    case "issue":
    case "workItem":
      return <CircleDotIcon className={props.className} aria-hidden />;
    case "branch":
      return <GitBranchIcon className={props.className} aria-hidden />;
    case "thread":
      return <MessageSquareIcon className={props.className} aria-hidden />;
    case "url":
      return <LinkIcon className={props.className} aria-hidden />;
  }
}
