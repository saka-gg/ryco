import { MessageId } from "@ryco/contracts";
import { type DiffRouteSearch, parseDiffRouteSearch } from "./diffRouteSearch";
import { type PreviewRouteSearch, parsePreviewRouteSearch } from "./previewRouteSearch";
import { type WorkspaceRouteSearch, parseWorkspaceRouteSearch } from "./workspaceRouteSearch";

export type RightPanelMode =
  | "review"
  | "files"
  | "terminal"
  | "simulator"
  | "browser"
  | "agent"
  | "agents";

export interface MessageRouteSearch {
  messageId?: MessageId;
}

export type RightPanelRouteSearch = DiffRouteSearch &
  PreviewRouteSearch &
  WorkspaceRouteSearch &
  MessageRouteSearch;

function parseMessageRouteSearch(search: Record<string, unknown>): MessageRouteSearch {
  const rawMessageId = typeof search.messageId === "string" ? search.messageId.trim() : "";
  return rawMessageId.length > 0 ? { messageId: MessageId.make(rawMessageId) } : {};
}

export function parseRightPanelRouteSearch(search: Record<string, unknown>): RightPanelRouteSearch {
  const workspaceSearch = parseWorkspaceRouteSearch(search);
  const diffSearch = parseDiffRouteSearch(search);
  const previewSearch = parsePreviewRouteSearch(search);
  const messageSearch = parseMessageRouteSearch(search);

  if (workspaceSearch.workspaceTab === "agent" && workspaceSearch.workspaceAgentKey) {
    return {
      ...workspaceSearch,
      ...messageSearch,
    };
  }
  if (workspaceSearch.workspaceTab === "review") {
    return {
      ...diffSearch,
      ...messageSearch,
      workspaceOpen: "1",
      workspaceTab: "review",
      diff: "1",
    };
  }
  if (workspaceSearch.workspaceTab === "files") {
    return {
      ...previewSearch,
      ...messageSearch,
      workspaceOpen: "1",
      workspaceTab: "files",
      preview: "1",
    };
  }
  if (workspaceSearch.workspaceTab === "terminal") {
    return {
      ...messageSearch,
      workspaceOpen: "1",
      workspaceTab: "terminal",
    };
  }
  if (workspaceSearch.workspaceTab === "browser")
    return { ...messageSearch, workspaceOpen: "1", workspaceTab: "browser" };
  if (workspaceSearch.workspaceTab === "simulator") {
    return {
      ...messageSearch,
      workspaceOpen: "1",
      workspaceTab: "simulator",
    };
  }
  if (workspaceSearch.workspaceTab === "agents") {
    return {
      ...messageSearch,
      workspaceOpen: "1",
      workspaceTab: "agents",
    };
  }

  if (diffSearch.diff === "1") {
    return {
      ...diffSearch,
      ...messageSearch,
      workspaceOpen: "1",
      workspaceTab: "review",
    };
  }
  if (previewSearch.preview === "1") {
    return {
      ...previewSearch,
      ...messageSearch,
      workspaceOpen: "1",
      workspaceTab: "files",
    };
  }
  if (workspaceSearch.workspaceOpen === "1") {
    return {
      ...workspaceSearch,
      ...messageSearch,
    };
  }
  return messageSearch;
}

export function getRightPanelMode(search: RightPanelRouteSearch): RightPanelMode | null {
  if (search.workspaceTab === "agents") return "agents";
  if (search.workspaceTab === "agent" && search.workspaceAgentKey) return "agent";
  if (search.workspaceTab === "review" || search.diff === "1") return "review";
  if (search.workspaceTab === "files" || search.preview === "1") return "files";
  if (search.workspaceTab === "terminal") return "terminal";
  if (search.workspaceTab === "simulator") return "simulator";
  if (search.workspaceTab === "browser") return "browser";
  return null;
}

export function isRightPanelOpen(search: RightPanelRouteSearch): boolean {
  return search.workspaceOpen === "1" || getRightPanelMode(search) !== null;
}
