import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";

import { removeLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { restorePullRequestsLayout, usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";

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
