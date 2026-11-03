import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The file screen shows one file's diff; it reads the pull request's detail
// (for the head and the host link) and its diff, never the activity. Rendered
// as a plain function over a tiny hook runtime (no React renderer exists in
// this suite): state persists across renders and effects run after each one,
// so the node's git status can name the host before the second render.

const hoisted = vi.hoisted(() => {
  const runtime = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as Array<() => void | (() => void)>,
  };
  return {
    runtime,
    reads: [] as Array<{ readonly query: string; readonly input: Record<string, unknown> }>,
  };
});

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
      const set = (next: T | ((current: T) => T)) => {
        runtime.slots[slot] =
          typeof next === "function" ? (next as (current: T) => T)(runtime.slots[slot] as T) : next;
      };
      return [runtime.slots[slot] as T, set] as const;
    },
    useEffect: (effect: () => void | (() => void)) => {
      runtime.effects.push(effect);
    },
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  useColorScheme: () => "dark",
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: "View",
}));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: "LegendList" }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ setOptions: () => undefined, setParams: () => undefined }),
}));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../components/EmptyState", () => ({ EmptyState: "EmptyState" }));
vi.mock("../../components/LoadingStrip", () => ({ LoadingStrip: "LoadingStrip" }));
vi.mock("../../lib/appearancePreferences", () => ({
  resolveMobileCodeSurface: () => ({
    fontSize: 12,
    lineNumberFontSize: 10,
    rowHeight: 18,
    codePadding: 8,
  }),
}));
vi.mock("../../lib/openWebLink", () => ({ openWebLink: () => undefined }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#ffffff" }));
vi.mock("../review/shikiReviewHighlighter", () => ({
  highlightSourceFile: async () => [],
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { codeFontSize: "default" } }),
}));
vi.mock("../../connection/useEnvironmentApi", () => ({
  useEnvironmentApi: () => ({
    vcs: {
      onStatus: (_input: unknown, listener: (status: unknown) => void) => {
        listener({
          sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
        });
        return () => undefined;
      },
    },
  }),
}));
vi.mock("../../connection/hostedConnectionScopes", () => ({
  mobileHostedConnectionScopes: { retain: () => () => undefined },
}));
vi.mock("../../state/threadsRuntime", () => ({
  selectProjectByRef: () => ({ cwd: "/repo" }),
  useStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock("../../rpc/pullRequestAtoms", () => ({
  pullRequestActivityQuery: "activity",
  pullRequestDetailQuery: "detail",
  pullRequestDiffQuery: "diff",
  pullRequestListQuery: "list",
}));
vi.mock("../../rpc/useMobileQuery", () => ({
  useMobileQuery: (query: string, input: Record<string, unknown>) => {
    hoisted.reads.push({ query, input });
    return {
      data:
        query === "detail"
          ? { headSha: "abc123", provider: "github", url: "https://github.com/acme/app/pull/7" }
          : null,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: async () => ({ data: null }),
    };
  },
}));

import { PullRequestFileRouteScreen } from "./PullRequestFileRouteScreen";

function render(): void {
  const { runtime } = hoisted;
  runtime.index = 0;
  runtime.effects = [];
  PullRequestFileRouteScreen({
    route: {
      params: { environmentId: "env-1", projectId: "project-1", number: "7", path: "src/a.ts" },
    },
  } as unknown as Parameters<typeof PullRequestFileRouteScreen>[0]);
  for (const effect of runtime.effects) effect();
}

describe("PullRequestFileRouteScreen reads", () => {
  beforeEach(() => {
    hoisted.runtime.slots = [];
    hoisted.reads.length = 0;
  });

  it("reads the detail and the diff, never the activity, once the host is known", () => {
    render();
    hoisted.reads.length = 0;
    // The git status named GitHub, which serves activity reads.
    render();
    const enabled = hoisted.reads.filter((read) => read.input.enabled !== false);
    expect(enabled.map((read) => read.query).toSorted()).toEqual(["detail", "diff"]);
  });
});
