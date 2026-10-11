import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vite-plus/test/browser";
import type { ChangeRequest, EnvironmentId, SourceControlIssueSummary } from "@ryco/contracts";

const issueListData: SourceControlIssueSummary[] = [
  {
    provider: "github",
    number: 42 as never,
    title: "Fix the authentication bug",
    url: "https://github.com/owner/repo/issues/42",
    state: "open",
    updatedAt: { _tag: "None" } as never,
  },
  {
    provider: "github",
    number: 7 as never,
    title: "Update the README with examples",
    url: "https://github.com/owner/repo/issues/7",
    state: "open",
    updatedAt: { _tag: "None" } as never,
  },
];

const prListData: ChangeRequest[] = [
  {
    provider: "github",
    number: 99 as never,
    title: "feat: add dark mode",
    url: "https://github.com/owner/repo/pull/99",
    baseRefName: "main" as never,
    headRefName: "feat/dark-mode" as never,
    state: "open",
    updatedAt: { _tag: "None" } as never,
  },
];

// ---------------------------------------------------------------------------
// Mock the atom-backed source-control hooks so we can inject test data
// without a real server.
// ---------------------------------------------------------------------------

function readyState<T>(data: T) {
  return { data, isLoading: false, isFetching: false, error: null };
}

function searchState(input: { enabled?: boolean }) {
  // Server search is only consulted when enabled; the tests exercise the
  // client-side filter path, so the search result stays empty.
  return { data: input.enabled ? [] : null, isLoading: false, isFetching: false, error: null };
}

vi.mock("~/rpc/useSourceControl", () => ({
  useSourceControlIssueList: vi.fn(() => readyState(issueListData)),
  useSourceControlChangeRequestList: vi.fn(() => readyState(prListData)),
  useSourceControlIssueSearch: vi.fn((input: { enabled?: boolean }) => searchState(input)),
  useSourceControlChangeRequestSearch: vi.fn((input: { enabled?: boolean }) => searchState(input)),
}));

// ---------------------------------------------------------------------------
// Import the component under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import { ContextPickerPopup } from "./ContextPickerPopup";

const TEST_ENVIRONMENT_ID = "environment-local" as unknown as EnvironmentId;
const TEST_CWD = "/repo/project";

async function mountPopup(overrides?: {
  onSelectIssue?: (issue: SourceControlIssueSummary) => void;
  onSelectChangeRequest?: (cr: ChangeRequest) => void;
  onAttachFile?: (file: File) => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);

  const onSelectIssue = overrides?.onSelectIssue ?? vi.fn();
  const onSelectChangeRequest = overrides?.onSelectChangeRequest ?? vi.fn();
  const onAttachFile = overrides?.onAttachFile ?? vi.fn();

  const screen = await render(
    <ContextPickerPopup
      environmentId={TEST_ENVIRONMENT_ID}
      cwd={TEST_CWD}
      hasSourceControlRemote={true}
      onSelectIssue={onSelectIssue}
      onSelectChangeRequest={onSelectChangeRequest}
      onAttachFile={onAttachFile}
    />,
    { container: host },
  );

  return {
    onSelectIssue,
    onSelectChangeRequest,
    onAttachFile,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ContextPickerPopup", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders GH Issues tab by default and shows issue list", async () => {
    const { cleanup } = await mountPopup();

    try {
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("#42");
        expect(text).toContain("Fix the authentication bug");
        expect(text).toContain("#7");
        expect(text).toContain("Update the README with examples");
      });
    } finally {
      await cleanup();
    }
  });

  it("filters issues by client-side search when query is typed", async () => {
    const { cleanup } = await mountPopup();

    try {
      // Wait for initial render
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("#42");
      });

      const searchInput = page.getByPlaceholder("Search…");
      await searchInput.fill("README");

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("#7");
        expect(text).toContain("Update the README with examples");
        expect(text).not.toContain("Fix the authentication bug");
      });
    } finally {
      await cleanup();
    }
  });

  it("switches to GH PRs tab and renders PR list", async () => {
    const { cleanup } = await mountPopup();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("PRs");
      });

      await page.getByRole("tab", { name: "PRs", exact: false }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("#99");
        expect(text).toContain("feat: add dark mode");
      });
    } finally {
      await cleanup();
    }
  });

  it("calls onSelectIssue with the correct item when an issue is clicked", async () => {
    const onSelectIssue = vi.fn();
    const { cleanup } = await mountPopup({ onSelectIssue });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Fix the authentication bug");
      });

      await userEvent.click(page.getByRole("button", { name: /Fix the authentication bug/i }));

      await vi.waitFor(() => {
        expect(onSelectIssue).toHaveBeenCalledTimes(1);
        expect(onSelectIssue.mock.calls[0]?.[0]?.number).toBe(42);
      });
    } finally {
      await cleanup();
    }
  });
});
