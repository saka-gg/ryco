import type { WorkItemStateFilter } from "@ryco/contracts";
import { useState } from "react";

import type {
  ChangeRequestStateFilter,
  IssueStateFilter,
} from "../projectExplorer/StateFilterButtons";

/**
 * The picker's tab, searches and filters. Its popover unmounts the panel when
 * it closes, so the trigger keeps them: the picker opens again where it was.
 */
export function useSourcePickerState(initialTab: string = "branches") {
  const [tab, setTab] = useState(initialTab);
  const [branchQuery, setBranchQuery] = useState("");
  const [prQuery, setPrQuery] = useState("");
  const [issueQuery, setIssueQuery] = useState("");
  const [workItemQuery, setWorkItemQuery] = useState("");
  const [prStateFilter, setPrStateFilter] = useState<ChangeRequestStateFilter>("open");
  const [issueStateFilter, setIssueStateFilter] = useState<IssueStateFilter>("open");
  const [workItemStateFilter, setWorkItemStateFilter] = useState<WorkItemStateFilter>("open");
  return {
    tab,
    setTab,
    branchQuery,
    setBranchQuery,
    prQuery,
    setPrQuery,
    issueQuery,
    setIssueQuery,
    workItemQuery,
    setWorkItemQuery,
    prStateFilter,
    setPrStateFilter,
    issueStateFilter,
    setIssueStateFilter,
    workItemStateFilter,
    setWorkItemStateFilter,
  };
}

export type SourcePickerState = ReturnType<typeof useSourcePickerState>;
