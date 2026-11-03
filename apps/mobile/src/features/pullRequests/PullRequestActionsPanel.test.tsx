import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PullRequestActionsControl } from "./usePullRequestActions";

// A refresh can take an action away while its sheet is open (the pull request
// was merged elsewhere). The sheet then closes rather than going blank with no
// way out, and does not pop back if the action returns. Rendered as a plain
// function over a hook runtime whose state persists across renders (no React
// renderer exists in this suite).

const hoisted = vi.hoisted(() => ({
  runtime: { slots: [] as unknown[], index: 0 },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { runtime } = hoisted;
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const slot = runtime.index++;
      if (!(slot in runtime.slots)) {
        runtime.slots[slot] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const set = (next: T) => {
        runtime.slots[slot] = next;
      };
      return [runtime.slots[slot] as T, set] as const;
    },
  };
});
vi.mock("react-native", () => ({
  Alert: { alert: () => undefined },
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../components/ErrorBanner", () => ({ ErrorBanner: "ErrorBanner" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#ffffff" }));
vi.mock("./PullRequestParts", () => ({ FilterChip: "FilterChip" }));
vi.mock("./usePullRequestActions", () => ({ usePullRequestReviewDraft: () => null }));

import { PullRequestActionsPanel } from "./PullRequestActionsPanel";

type Props = Record<string, unknown> & { readonly children?: unknown };

function find(node: unknown, match: (props: Props, type: unknown) => boolean): Props | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as ReactElement<Props>;
  if (match(element.props, element.type)) return element.props;
  return find(element.props.children, match);
}

const REVIEW = { options: [], authorNote: null };
const MERGE = {
  methods: null,
  method: "squash" as const,
  label: "Squash and merge",
  confirmLabel: "Confirm squash and merge",
  deleteBranchDefault: null,
};

function control(overrides: Partial<PullRequestActionsControl> = {}): PullRequestActionsControl {
  return {
    blockedReason: null,
    review: REVIEW,
    merge: MERGE,
    updateBranch: null,
    pending: null,
    error: null,
    notice: null,
    draftKey: "draft",
    reviewEventFor: () => "comment",
    setMethod: () => undefined,
    deleteBranch: null,
    setDeleteBranch: () => undefined,
    submitReview: () => undefined,
    runMerge: () => undefined,
    runUpdateBranch: () => undefined,
    ...overrides,
  };
}

function render(value: PullRequestActionsControl) {
  hoisted.runtime.index = 0;
  const tree = PullRequestActionsPanel({ control: value });
  const modal = find(tree, (_props, type) => type === "Modal");
  return {
    visible: modal?.visible === true,
    press: (label: string) => {
      const button = find(tree, (props) => props.label === label);
      if (!button) throw new Error(`No "${label}" button`);
      (button.onPress as () => void)();
    },
  };
}

describe("PullRequestActionsPanel sheets", () => {
  beforeEach(() => {
    hoisted.runtime.slots = [];
  });

  it("opens the sheet the reader asked for", () => {
    render(control()).press("Review");
    expect(render(control()).visible).toBe(true);
  });

  it("closes a sheet whose action went away, and keeps it closed if the action returns", () => {
    render(control()).press("Review");
    expect(render(control({ review: null })).visible).toBe(false);
    expect(render(control()).visible).toBe(false);

    render(control()).press("Squash and merge");
    expect(render(control({ merge: null })).visible).toBe(false);
    expect(render(control()).visible).toBe(false);
  });
});
