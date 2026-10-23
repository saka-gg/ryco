import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { isReactCompilerModule } from "../viteBuild/reactCompilerScope";
import { analyzeReactCompilerModule, type ReactCompilerReport } from "./reactCompilerBailouts";
import { KNOWN_BAILOUTS, OPTED_OUT } from "./reactCompilerKnownBailouts";

/**
 * The sidebar, inbox, composer and thread view components below re-render on
 * store commits while threads stream or the view switches. They rely on the
 * React Compiler for memoization; a single rule violation (a render-time ref
 * write, a conditional inside try/finally, a store hook read as a value) makes
 * it skip the whole component silently, and the regression only shows up as
 * per-commit CPU. Each listed function must compile, and no function of a
 * listed file may bail out.
 */
const HOT_COMPONENTS: ReadonlyArray<{ readonly file: string; readonly functions: string[] }> = [
  { file: "src/components/Sidebar.tsx", functions: ["Sidebar"] },
  { file: "src/components/sidebar/SidebarProjectItem.tsx", functions: ["SidebarProjectItem"] },
  {
    file: "src/components/sidebar/SidebarProjectThreadList.tsx",
    functions: ["SidebarProjectThreadList", "useStableOrderedThreadKeys"],
  },
  { file: "src/components/sidebar/SidebarWorktreeList.tsx", functions: ["SidebarWorktreeList"] },
  {
    file: "src/components/sidebar/SidebarThreadRow.tsx",
    functions: ["SidebarThreadRow", "SidebarThreadRowContent"],
  },
  { file: "src/components/sidebar/SidebarChatList.tsx", functions: ["SidebarChatList"] },
  {
    file: "src/components/ProjectFavicon.tsx",
    functions: ["ProjectFavicon", "ProjectFaviconImage", "ProjectMonogram"],
  },
  { file: "src/components/inboxSidebar/InboxSidebar.tsx", functions: ["InboxSidebar"] },
  {
    file: "src/components/inboxSidebar/ConnectedInboxSidebar.tsx",
    functions: ["ConnectedInboxSidebar"],
  },
  { file: "src/components/inboxSidebar/InboxThreadRow.tsx", functions: ["InboxThreadRow"] },
  {
    file: "src/components/sidebar/hooks/useThreadMenuActions.ts",
    functions: ["useThreadMenuActions"],
  },
  { file: "src/hooks/useSettings.ts", functions: ["useSettings"] },
  // Sidebar calls these on every render; an uncompiled hook hands it a new
  // new-thread handler each time, which re-renders every project row.
  {
    file: "src/hooks/useHandleNewThread.ts",
    functions: ["useNewThreadState", "useNewThreadHandler"],
  },
  { file: "src/hooks/useProjectGroupingSettings.ts", functions: ["useProjectGroupingSettings"] },
  {
    file: "src/components/chat/ChatComposer.tsx",
    functions: ["ChatComposer", "useSetPromptFromTraits"],
  },
  // Mounted in every chat's toolbar and the new-thread hero; it re-renders on
  // each git status and ref list update.
  {
    file: "src/components/BranchToolbarBranchSelector.tsx",
    functions: ["BranchToolbarBranchSelector"],
  },
  // The transcript's list owner re-renders for every prop change of the thread
  // view; its row stabilizer keeps unchanged rows referentially equal.
  {
    file: "src/components/chat/MessagesTimeline.tsx",
    functions: ["MessagesTimeline", "useStableRows"],
  },
  // Mounted wherever a thread offers source control actions; it re-renders on
  // each git status update.
  { file: "src/components/GitActionsControl.tsx", functions: ["GitActionsControl"] },
];

// The work is about a second of parallel native transforms; loaded CI runners
// have taken several times that.
const TIMEOUT_MS = 60_000;

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const webRelative = (file: string) => relative(webRoot, file).split(sep).join("/");

/** Every module the web build runs through the React Compiler. */
const COMPILED_MODULES = readdirSync(join(webRoot, "src"), { recursive: true })
  .map(String)
  .filter((path) => /\.[jt]sx?$/.test(path) && !path.endsWith(".d.ts"))
  .map((path) => join(webRoot, "src", path))
  .filter(isReactCompilerModule)
  .toSorted();

let reports: Promise<ReadonlyMap<string, ReactCompilerReport>> | undefined;
function loadReports(): Promise<ReadonlyMap<string, ReactCompilerReport>> {
  reports ??= Promise.all(
    COMPILED_MODULES.map(
      async (file) =>
        [
          webRelative(file),
          await analyzeReactCompilerModule(file, await readFile(file, "utf8")),
        ] as const,
    ),
  ).then((entries) => new Map(entries));
  return reports;
}

type FunctionsByModule = Readonly<Record<string, ReadonlyArray<string>>>;

function functionsByModule(
  all: ReadonlyMap<string, ReactCompilerReport>,
  select: (report: ReactCompilerReport) => ReadonlyArray<string>,
): FunctionsByModule {
  return Object.fromEntries(
    [...all]
      .map(([file, report]) => [file, select(report)] as const)
      .filter(([, functions]) => functions.length > 0),
  );
}

/** Lists the drift from `expected` and the regenerated object to paste. */
function describeDrift(input: {
  readonly actual: FunctionsByModule;
  readonly expected: FunctionsByModule;
  readonly detail: (file: string, fn: string) => string;
  readonly added: string;
  readonly removed: string;
}): string {
  const added: string[] = [];
  const removed: string[] = [];
  for (const file of new Set([...Object.keys(input.actual), ...Object.keys(input.expected)])) {
    const actual = input.actual[file] ?? [];
    const expected = input.expected[file] ?? [];
    for (const fn of actual) {
      if (!expected.includes(fn)) added.push(`${file} › ${fn}\n${input.detail(file, fn)}`);
    }
    for (const fn of expected) if (!actual.includes(fn)) removed.push(`${file} › ${fn}`);
  }
  if (added.length === 0 && removed.length === 0) return "";
  return [
    ...(added.length > 0 ? [input.added, ...added] : []),
    ...(removed.length > 0 ? [input.removed, ...removed] : []),
    "Current list:",
    JSON.stringify(input.actual, null, 2),
  ].join("\n\n");
}

describe("React Compiler coverage of web modules", () => {
  it("selects the web modules the build compiles", () => {
    expect(COMPILED_MODULES.length).toBeGreaterThan(1000);
    expect(COMPILED_MODULES.map(webRelative)).toContain("src/components/ChatView.tsx");
    expect(COMPILED_MODULES.map(webRelative)).not.toContain(
      "src/perf/reactCompilerCoverage.test.ts",
    );
  });

  it(
    "skips exactly the functions listed in KNOWN_BAILOUTS",
    async () => {
      const all = await loadReports();
      const actual = functionsByModule(all, (report) => report.bailouts.map(({ fn }) => fn));
      const message = describeDrift({
        actual,
        expected: KNOWN_BAILOUTS,
        detail: (file, fn) =>
          all
            .get(file)
            ?.bailouts.find((bailout) => bailout.fn === fn)
            ?.codeframes.join("\n") ?? "",
        added:
          'New bailouts. Fix them, or opt the function out with a reasoned "use no memo" and an OPTED_OUT entry:',
        removed: "These now compile (or are gone). Remove them from KNOWN_BAILOUTS:",
      });
      expect(actual, message).toEqual(KNOWN_BAILOUTS);
    },
    TIMEOUT_MS,
  );

  // The ratchet reads every diagnostic as a skipped function. Should a
  // compiler bump start reporting diagnostics for functions it still compiles,
  // say so here rather than through KNOWN_BAILOUTS drift.
  it(
    "compiles none of the functions it reports diagnostics for",
    async () => {
      const compiledDespiteDiagnostics = [...(await loadReports())].flatMap(([file, report]) =>
        report.bailouts
          .filter(({ fn }) => report.compiled.includes(fn))
          .map(({ fn, reasons }) => `${file} › ${fn}: ${reasons.join("; ")}`),
      );
      expect(compiledDespiteDiagnostics).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'lists every "use no memo" opt-out with its reason in OPTED_OUT',
    async () => {
      const actual = functionsByModule(await loadReports(), (report) => report.optedOut);
      const expected = Object.fromEntries(
        Object.entries(OPTED_OUT).map(([file, reasons]) => [file, Object.keys(reasons).toSorted()]),
      );
      const message = describeDrift({
        actual,
        expected,
        detail: () => "",
        added: 'New "use no memo" opt-outs. Add each to OPTED_OUT with its reason:',
        removed: "These no longer opt out (or are gone). Remove them from OPTED_OUT:",
      });
      expect(actual, message).toEqual(expected);
      for (const reasons of Object.values(OPTED_OUT)) {
        for (const reason of Object.values(reasons)) expect(reason.trim()).not.toBe("");
      }
    },
    TIMEOUT_MS,
  );

  for (const { file, functions } of HOT_COMPONENTS) {
    it(
      `compiles ${functions.join(", ")} in ${file}`,
      async () => {
        const report = (await loadReports()).get(file);
        expect(report, `${file} is not compiled by the web build`).toBeDefined();
        expect(report?.bailouts.map(({ fn, reasons }) => `${fn}: ${reasons.join("; ")}`)).toEqual(
          [],
        );
        expect(
          functions.filter((fn) => report?.optedOut.includes(fn)),
          'A hot function must not opt out with "use no memo"',
        ).toEqual([]);
        expect(
          functions.filter((fn) => !report?.compiled.includes(fn)),
          "Not compiled: renamed, or no longer shaped like a component or hook?",
        ).toEqual([]);
      },
      TIMEOUT_MS,
    );
  }
});
