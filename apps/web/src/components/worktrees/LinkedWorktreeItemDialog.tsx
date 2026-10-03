import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useCallback, useState } from "react";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { IssueDetail } from "../projectExplorer/IssueDetail";
import { PullRequestDetail } from "../projectExplorer/PullRequestDetail";
import { WorkItemDetail } from "../projectExplorer/WorkItemDetail";

export type LinkedWorktreeItem =
  | { kind: "pr"; number: number }
  | { kind: "issue"; number: number }
  | { kind: "workItem"; provider: "jira"; key: string };

export interface LinkedWorktreeItemDialogProps {
  open: boolean;
  item: LinkedWorktreeItem | null;
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  cwd: string | null;
  onOpenChange: (open: boolean) => void;
}

type Pivot = { kind: "issue"; number: number } | { kind: "pr"; number: number } | null;

export function LinkedWorktreeItemDialog(props: LinkedWorktreeItemDialogProps) {
  const [pivot, setPivot] = useState<Pivot>(null);

  const close = useCallback(() => props.onOpenChange(false), [props]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setPivot(null);
      }
      props.onOpenChange(next);
    },
    [props],
  );

  const handleSelectLinkedIssue = useCallback((issueNumber: number) => {
    setPivot({ kind: "issue", number: issueNumber });
  }, []);

  const handleSelectLinkedChangeRequest = useCallback((number: number) => {
    setPivot({ kind: "pr", number });
  }, []);

  const handleBackFromPivot = useCallback(() => {
    setPivot(null);
  }, []);

  const item = props.item;

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup className="flex h-[92vh] max-h-[1120px] w-[96vw] max-w-[1440px] flex-col overflow-hidden p-0 phone:h-[100dvh] phone:w-screen">
        <DialogTitle className="sr-only">
          {item?.kind === "pr"
            ? `Pull request #${item.number}`
            : item?.kind === "issue"
              ? `Issue #${item.number}`
              : item?.kind === "workItem"
                ? item.key
                : "Linked item"}
        </DialogTitle>

        {item === null ? null : pivot !== null ? (
          pivot.kind === "issue" ? (
            <IssueDetail
              environmentId={props.environmentId}
              cwd={props.cwd}
              issueNumber={pivot.number}
              onBack={handleBackFromPivot}
              onSelectLinkedChangeRequest={handleSelectLinkedChangeRequest}
            />
          ) : (
            <PullRequestDetail
              environmentId={props.environmentId}
              cwd={props.cwd}
              pullRequestNumber={pivot.number}
              onBack={handleBackFromPivot}
              onSelectLinkedIssue={handleSelectLinkedIssue}
              onSelectPullRequest={handleSelectLinkedChangeRequest}
            />
          )
        ) : item.kind === "workItem" ? (
          <WorkItemDetail
            environmentId={props.environmentId}
            projectId={props.projectId}
            cwd={props.cwd}
            workItemKey={item.key}
            onBack={close}
            onSelectLinkedChangeRequest={handleSelectLinkedChangeRequest}
          />
        ) : item.kind === "pr" ? (
          <PullRequestDetail
            environmentId={props.environmentId}
            cwd={props.cwd}
            pullRequestNumber={item.number}
            onBack={close}
            onSelectLinkedIssue={handleSelectLinkedIssue}
            onSelectPullRequest={handleSelectLinkedChangeRequest}
          />
        ) : (
          <IssueDetail
            environmentId={props.environmentId}
            cwd={props.cwd}
            issueNumber={item.number}
            onBack={close}
            onSelectLinkedChangeRequest={handleSelectLinkedChangeRequest}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
