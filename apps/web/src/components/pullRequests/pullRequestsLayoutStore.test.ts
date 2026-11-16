import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  MAX_REMEMBERED_READERS,
  readPullRequestScrollTop,
  restorePullRequestsLayout,
  usePullRequestReaderStore,
  usePullRequestsLayoutStore,
} from "./pullRequestsLayoutStore";

const STORAGE_KEY = "ryco:pull-requests-layout:v1";

/** The layout as saved before the page remembered All repositories. */
const LayoutBeforeScope = Schema.Struct({
  listWidth: Schema.Number,
  listHidden: Schema.Boolean,
  treeHidden: Schema.Boolean,
  foldedGroups: Schema.Array(Schema.String),
  lastRepositoryKey: Schema.NullOr(Schema.String),
});

afterEach(() => removeLocalStorageItem(STORAGE_KEY));

describe("pull requests layout memory", () => {
  it("keeps a layout saved before the scope existed", () => {
    setLocalStorageItem(
      STORAGE_KEY,
      {
        listWidth: 360,
        listHidden: true,
        treeHidden: false,
        foldedGroups: ["others"],
        lastRepositoryKey: "env\u0000project",
      },
      LayoutBeforeScope,
    );
    expect(restorePullRequestsLayout()).toEqual({
      listWidth: 360,
      listHidden: true,
      treeHidden: false,
      foldedGroups: ["others"],
      lastRepositoryKey: "env\u0000project",
      lastScope: null,
    });
  });

  it("remembers All repositories until a repository is chosen", () => {
    usePullRequestsLayoutStore.getState().setLastScope("all");
    expect(restorePullRequestsLayout().lastScope).toBe("all");
    usePullRequestsLayoutStore.getState().setLastScope(null);
    expect(restorePullRequestsLayout().lastScope).toBeNull();
  });
});

describe("pull request reader memory", () => {
  const getState = () => usePullRequestReaderStore.getState();
  const reader = (index: number) => `repo\u0000${index}`;

  beforeEach(() => {
    usePullRequestReaderStore.setState({
      visitedTabs: {},
      scrollTop: {},
      expandedJobs: {},
      mastheadHidden: {},
      titleEditRequest: {},
    });
  });

  it("keeps the same state object when the same offset is saved twice", () => {
    getState().setScrollTop(reader(1), "conversation", 120);
    const before = getState().scrollTop;
    getState().setScrollTop(reader(1), "conversation", 120);
    expect(getState().scrollTop).toBe(before);
  });

  it("bounds the remembered scroll offsets", () => {
    for (let index = 0; index < MAX_REMEMBERED_READERS + 6; index += 1) {
      getState().setScrollTop(reader(index), "conversation", index + 1);
    }
    const keys = Object.keys(getState().scrollTop);
    expect(keys).toHaveLength(MAX_REMEMBERED_READERS);
    for (let index = 0; index < 6; index += 1) expect(keys).not.toContain(reader(index));
    const last = MAX_REMEMBERED_READERS + 5;
    expect(readPullRequestScrollTop(reader(last), "conversation")).toBe(last + 1);
  });

  it("drops the least recently touched reader first", () => {
    for (let index = 0; index < MAX_REMEMBERED_READERS; index += 1) {
      getState().setScrollTop(reader(index), "conversation", 1);
    }
    getState().setScrollTop(reader(0), "conversation", 2);
    getState().setScrollTop(reader(MAX_REMEMBERED_READERS), "conversation", 1);
    const keys = Object.keys(getState().scrollTop);
    expect(keys).toContain(reader(0));
    expect(keys).not.toContain(reader(1));
    expect(readPullRequestScrollTop(reader(0), "conversation")).toBe(2);
  });

  it("bounds the remembered title-edit requests", () => {
    for (let index = 0; index < MAX_REMEMBERED_READERS + 3; index += 1) {
      getState().requestTitleEdit(reader(index));
    }
    expect(Object.keys(getState().titleEditRequest)).toHaveLength(MAX_REMEMBERED_READERS);
  });
});
