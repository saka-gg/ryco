import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * The sidebar, inbox and composer components below re-render on store commits
 * while threads stream. They rely on the React Compiler for memoization; a single
 * rule violation (a render-time ref write, a conditional inside try/catch, a
 * store hook read as a value) makes it skip the whole component silently, and
 * the regression only shows up as per-commit CPU. Compile them the way the
 * build does and fail on any bailout.
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
];

interface CompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null;
  readonly detail?: { readonly reason?: string; readonly options?: { readonly reason?: string } };
}

type BabelTransform = (
  code: string,
  options: Record<string, unknown>,
) => { readonly code?: string | null } | null;

/** @babel/core is a peer of the build's Babel plugin, not a direct dependency. */
function loadBabelTransform(): BabelTransform {
  const requireFromWeb = createRequire(import.meta.url);
  const requireFromBabelPlugin = createRequire(requireFromWeb.resolve("@rolldown/plugin-babel"));
  const babel = requireFromBabelPlugin("@babel/core") as { transformSync: BabelTransform };
  return babel.transformSync;
}

describe("React Compiler coverage of hot sidebar components", () => {
  const transformSync = loadBabelTransform();
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
      const output = transformSync(source, {
        filename: fileURLToPath(url),
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
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
