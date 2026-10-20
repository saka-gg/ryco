import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * The sidebar, inbox, composer and thread view components below re-render on
 * store commits while threads stream or the view switches. They rely on the
 * React Compiler for memoization; a single rule violation (a render-time ref
 * write, a conditional inside try/catch, a store hook read as a value) makes it
 * skip the whole component silently, and the regression only shows up as
 * per-commit CPU. Compile them the way the build does and fail on any bailout.
 * A function that opts out with a `"use no memo"` directive does so on purpose
 * and is not counted; every other function of a listed file must compile.
 */
const HOT_COMPONENTS: ReadonlyArray<{ readonly file: string; readonly functions: string[] }> = [
  { file: "../components/Sidebar.tsx", functions: ["Sidebar"] },
  { file: "../components/sidebar/SidebarProjectItem.tsx", functions: ["SidebarProjectItem"] },
  {
    file: "../components/sidebar/SidebarProjectThreadList.tsx",
    functions: ["SidebarProjectThreadList", "useStableOrderedThreadKeys"],
  },
  { file: "../components/sidebar/SidebarWorktreeList.tsx", functions: ["SidebarWorktreeList"] },
  {
    file: "../components/sidebar/SidebarThreadRow.tsx",
    functions: ["SidebarThreadRow", "SidebarThreadRowContent"],
  },
  { file: "../components/sidebar/SidebarChatList.tsx", functions: ["SidebarChatList"] },
  {
    file: "../components/ProjectFavicon.tsx",
    functions: ["ProjectFavicon", "ProjectFaviconImage", "ProjectMonogram"],
  },
  { file: "../components/inboxSidebar/InboxSidebar.tsx", functions: ["InboxSidebar"] },
  {
    file: "../components/inboxSidebar/ConnectedInboxSidebar.tsx",
    functions: ["ConnectedInboxSidebar"],
  },
  { file: "../components/inboxSidebar/InboxThreadRow.tsx", functions: ["InboxThreadRow"] },
  {
    file: "../components/sidebar/hooks/useThreadMenuActions.ts",
    functions: ["useThreadMenuActions"],
  },
  { file: "../hooks/useSettings.ts", functions: ["useSettings"] },
  // Sidebar calls these on every render; an uncompiled hook hands it a new
  // new-thread handler each time, which re-renders every project row.
  {
    file: "../hooks/useHandleNewThread.ts",
    functions: ["useNewThreadState", "useNewThreadHandler"],
  },
  { file: "../hooks/useProjectGroupingSettings.ts", functions: ["useProjectGroupingSettings"] },
  {
    file: "../components/chat/ChatComposer.tsx",
    functions: ["ChatComposer", "useSetPromptFromTraits"],
  },
  // Mounted in every chat's toolbar and the new-thread hero; it re-renders on
  // each git status and ref list update.
  {
    file: "../components/BranchToolbarBranchSelector.tsx",
    functions: ["BranchToolbarBranchSelector"],
  },
  // The transcript's list owner re-renders for every prop change of the thread
  // view; its row stabilizer keeps unchanged rows referentially equal.
  {
    file: "../components/chat/MessagesTimeline.tsx",
    functions: ["MessagesTimeline", "useStableRows"],
  },
  // Mounted wherever a thread offers source control actions; it re-renders on
  // each git status update.
  { file: "../components/GitActionsControl.tsx", functions: ["GitActionsControl"] },
];

interface CompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null;
  readonly fnLoc?: { readonly start: { readonly line: number } } | null;
  readonly detail?: { readonly reason?: string; readonly options?: { readonly reason?: string } };
}

interface BabelFunctionPath {
  readonly node: {
    readonly loc?: { readonly start: { readonly line: number } } | null;
    readonly body: {
      readonly type: string;
      readonly directives?: ReadonlyArray<{ readonly value: { readonly value: string } }>;
    };
  };
}

interface Babel {
  readonly transformSync: (
    code: string,
    options: Record<string, unknown>,
  ) => { readonly code?: string | null } | null;
  readonly parseSync: (code: string, options: Record<string, unknown>) => object | null;
  readonly traverse: (
    ast: object,
    visitor: { readonly Function: (path: BabelFunctionPath) => void },
  ) => void;
}

/** @babel/core is a peer of the build's Babel plugin, not a direct dependency. */
function loadBabel(): Babel {
  const requireFromWeb = createRequire(import.meta.url);
  const requireFromBabelPlugin = createRequire(requireFromWeb.resolve("@rolldown/plugin-babel"));
  return requireFromBabelPlugin("@babel/core") as Babel;
}

const PARSER_OPTIONS = { plugins: ["typescript", "jsx"] };

/** First lines of the functions that opt out of compilation with `"use no memo"`. */
function findOptedOutFunctionLines(babel: Babel, source: string, filename: string): Set<number> {
  const lines = new Set<number>();
  const ast = babel.parseSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: PARSER_OPTIONS,
  });
  if (ast === null) return lines;
  babel.traverse(ast, {
    Function(path) {
      const { body, loc } = path.node;
      const optsOut =
        body.type === "BlockStatement" &&
        (body.directives ?? []).some((directive) => directive.value.value === "use no memo");
      if (optsOut && loc) lines.add(loc.start.line);
    },
  });
  return lines;
}

describe("React Compiler coverage of hot components", () => {
  const babel = loadBabel();
  const requireFromWeb = createRequire(import.meta.url);
  const compilerModule = requireFromWeb("babel-plugin-react-compiler") as {
    readonly default?: unknown;
  };
  const compilerPlugin = compilerModule.default ?? compilerModule;

  for (const { file, functions } of HOT_COMPONENTS) {
    it(`compiles ${functions.join(", ")} without bailing out`, async () => {
      const url = new URL(file, import.meta.url);
      const source = await readFile(url, "utf8");
      const events: CompilerEvent[] = [];
      const filename = fileURLToPath(url);
      const optedOutLines = findOptedOutFunctionLines(babel, source, filename);
      const output = babel.transformSync(source, {
        filename,
        babelrc: false,
        configFile: false,
        parserOpts: PARSER_OPTIONS,
        plugins: [
          [
            compilerPlugin,
            {
              panicThreshold: "none",
              logger: { logEvent: (_filename: string, event: CompilerEvent) => events.push(event) },
            },
          ],
        ],
      });

      const failures = events
        .filter((event) => event.kind === "CompileError" || event.kind === "PipelineError")
        .filter((event) => !(event.fnLoc && optedOutLines.has(event.fnLoc.start.line)))
        .map((event) => event.detail?.reason ?? event.detail?.options?.reason ?? event.kind);
      expect(failures).toEqual([]);
      const compiled = events
        .filter((event) => event.kind === "CompileSuccess")
        .map((event) => event.fnName);
      for (const name of functions) {
        expect(compiled).toContain(name);
      }
      expect(output?.code ?? "").toContain("react/compiler-runtime");
    }, 30_000);
  }
});
