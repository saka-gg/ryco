// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * React Compiler coverage of the mobile render paths, asserted over the real
 * Babel transform.
 *
 * The compiler silently skips any function it cannot model (release builds run
 * it with `panicThreshold: "NONE"`), and Vitest never runs it, so a try/finally
 * in a handler or a moved directory quietly puts a hot screen back to
 * re-rendering everything on every streamed token. These checks fail instead.
 */

const require = createRequire(import.meta.url);
const APP = join(import.meta.dirname, "..", "..");
const BABEL_CONFIG = join(APP, "babel.config.js");
const METRO_CONFIG = join(APP, "metro.config.js");
const PRESET = require.resolve("babel-preset-expo", { paths: [APP] });
const METRO = createRequire(
  require.resolve("@expo/metro-config", {
    paths: [require.resolve("expo/package.json", { paths: [APP] })],
  }),
).resolve("metro/package.json");

interface BabelResult {
  readonly code?: string | null;
  readonly ast?: unknown;
}
interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}
interface AstPath {
  readonly node: AstNode;
  readonly parentPath: AstPath | null;
  readonly key: string | number | null;
}
interface BabelCore {
  readonly transformFileSync: (filename: string, options: object) => BabelResult | null;
  readonly traverse: (ast: unknown, visitors: Record<string, (path: AstPath) => void>) => void;
  readonly transformFromAstSync: (
    ast: unknown,
    code: string | undefined,
    options: object,
  ) => BabelResult | null;
}
interface CompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null;
  readonly fnLoc?: { readonly start: { readonly line: number } } | null;
  readonly detail?: { readonly reason?: string } | null;
}

const babel = createRequire(PRESET)("@babel/core") as BabelCore;
const metroPlugins = createRequire(METRO)("metro-transform-plugins") as {
  readonly importExportPlugin: unknown;
  readonly inlineRequiresPlugin: unknown;
};

// A release `expo export:embed` transform: the caller Expo's Metro worker uses
// once `experiments.reactCompiler` is on.
const RELEASE_CALLER = {
  name: "metro",
  bundler: "metro",
  platform: "ios",
  supportsReactCompiler: true,
  isDev: false,
};

function transformWithAppConfig(relativePath: string): BabelResult {
  const result = babel.transformFileSync(join(APP, relativePath), {
    cwd: APP,
    babelrc: false,
    configFile: BABEL_CONFIG,
    caller: RELEASE_CALLER,
    ast: true,
  });
  if (!result) throw new Error(`Babel produced no output for ${relativePath}`);
  return result;
}

/** Runs the compiler over every function in the file and returns its log. */
function compilerEvents(relativePath: string): ReadonlyArray<CompilerEvent> {
  const events: Array<CompilerEvent> = [];
  babel.transformFileSync(join(APP, relativePath), {
    cwd: APP,
    babelrc: false,
    configFile: false,
    caller: RELEASE_CALLER,
    code: false,
    presets: [
      [
        PRESET,
        {
          "react-compiler": {
            sources: () => true,
            logger: { logEvent: (_filename: string, event: CompilerEvent) => events.push(event) },
          },
        },
      ],
    ],
  });
  return events;
}

function describeFailures(events: ReadonlyArray<CompilerEvent>): ReadonlyArray<string> {
  return events
    .filter((event) => event.kind !== "CompileSuccess" && event.kind !== "CompileSkip")
    .map(
      (event) =>
        `${event.kind} in the function at line ${event.fnLoc?.start.line ?? "?"}: ${
          event.detail?.reason ?? "no reason"
        }`,
    );
}

function compiledFunctions(events: ReadonlyArray<CompilerEvent>): ReadonlyArray<string> {
  return events.filter((event) => event.kind === "CompileSuccess").map((event) => event.fnName!);
}

const COMPILER_RUNTIME = /require\("react\/compiler-runtime"\)|from "react\/compiler-runtime"/u;

// Reads of mutable state outside React: the live connection behind an
// environment, and the clock. In render they were re-read on every pass; in a
// compiled memo scope they are read only when the scope's inputs change.
const CONNECTION_READS = new Set(["readEnvironmentApi", "ensureEnvironmentApi", "readRpcClient"]);

function isCacheSlot(node: unknown): boolean {
  const member = node as AstNode;
  return (
    member?.type === "MemberExpression" &&
    member.computed === true &&
    (member.object as AstNode).type === "Identifier" &&
    (member.object as AstNode).name === "$"
  );
}

/** `$[n] !== dep || …` (an input check) or `$[n] === Symbol.for(sentinel)` (once per instance). */
function cacheScopeKind(test: AstNode): "inputs" | "sentinel" | null {
  if (test.type === "LogicalExpression" && test.operator === "||") {
    return cacheScopeKind(test.left as AstNode) === "inputs" ? "inputs" : null;
  }
  if (test.type !== "BinaryExpression" || !isCacheSlot(test.left)) return null;
  if (test.operator === "!==") return "inputs";
  const right = test.right as AstNode;
  const callee = right.type === "CallExpression" ? (right.callee as AstNode) : null;
  const sentinel = (right.arguments as ReadonlyArray<AstNode> | undefined)?.[0];
  return test.operator === "===" &&
    callee?.type === "MemberExpression" &&
    (callee.object as AstNode).name === "Symbol" &&
    sentinel?.value === "react.memo_cache_sentinel"
    ? "sentinel"
    : null;
}

/**
 * The innermost compiled memo scope a call runs in directly. A closure the
 * scope builds is not followed, so a read inside an array callback that an
 * explicit `useMemo` runs at once is left to that memo's own dependencies.
 */
function enclosingCacheScope(path: AstPath): "inputs" | "sentinel" | null {
  let child = path;
  for (let current = path.parentPath; current; child = current, current = current.parentPath) {
    if (/Function|Method/u.test(current.node.type)) return null;
    if (current.node.type === "IfStatement" && child.key === "consequent") {
      const kind = cacheScopeKind(current.node.test as AstNode);
      if (kind) return kind;
    }
  }
  return null;
}

function calleeName(node: AstNode): string | null {
  const callee = node.callee as AstNode;
  // Babel's CommonJS output calls imports as `(0, _module.name)(…)`.
  const target =
    callee.type === "SequenceExpression"
      ? (callee.expressions as ReadonlyArray<AstNode>).at(-1)!
      : callee;
  if (target.type === "Identifier") return target.name as string;
  if (target.type !== "MemberExpression") return null;
  const object = target.object as AstNode;
  const property = (target.property as AstNode).name as string;
  if (object.type === "Identifier" && object.name === "Date") return `Date.${property}`;
  if (object.type === "MemberExpression" && (object.property as AstNode).name === "supervisor") {
    return `supervisor.${property}`;
  }
  return property;
}

/** Connection reads in any compiled memo scope, and clock reads cached once per instance. */
function cachedImpureReads(relativePath: string): ReadonlyArray<string> {
  const { ast } = transformWithAppConfig(relativePath);
  const found: Array<string> = [];
  const visit = (path: AstPath) => {
    const name =
      path.node.type === "NewExpression"
        ? (path.node.callee as AstNode).name === "Date"
          ? "new Date"
          : null
        : calleeName(path.node);
    if (name === null) return;
    const scope = enclosingCacheScope(path);
    const connectionRead = CONNECTION_READS.has(name) || name === "supervisor.read";
    const clockRead = name === "Date.now" || name === "new Date" || name === "performance.now";
    if ((connectionRead && scope !== null) || (clockRead && scope === "sentinel")) {
      const line = (path.node.loc as { start: { line: number } } | undefined)?.start.line;
      found.push(`${relativePath}:${line ?? "?"}: ${name} cached in a ${scope}-keyed memo scope`);
    }
  };
  babel.traverse(ast, { CallExpression: visit, NewExpression: visit });
  return found;
}

function sourceFiles(directory: string): ReadonlyArray<string> {
  return readdirSync(join(APP, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name) ? [path] : [];
  });
}

describe("mobile React Compiler coverage", () => {
  it.each([
    ["src/features/threads/ThreadDetailScreen.tsx", ["ThreadDetailScreen", "TimelineRow"]],
    ["src/features/threads/ThreadComposer.tsx", ["ThreadComposer"]],
    ["src/features/threads/useThreadChecks.ts", ["useThreadChecks"]],
    ["src/features/threads/ThreadActivityFoldRow.tsx", ["ThreadActivityFoldRow"]],
    ["src/features/threads/PendingApprovalCard.tsx", ["PendingApprovalCard"]],
    ["src/features/threads/PendingUserInputCard.tsx", ["PendingUserInputCard"]],
    ["src/features/threads/AgentControlProposalCard.tsx", ["AgentControlProposalCard"]],
  ])("compiles every function in %s", (file, expected) => {
    const events = compilerEvents(file);
    expect(describeFailures(events)).toEqual([]);
    expect(compiledFunctions(events)).toEqual(expect.arrayContaining(expected));
  });

  it("compiles the message row, leaving only the audio row that mutates its player", () => {
    const events = compilerEvents("src/features/threads/ThreadMessage.tsx");
    expect(compiledFunctions(events)).toEqual(
      expect.arrayContaining(["ThreadMessage", "ImageAttachment", "VideoAttachmentRow"]),
    );
    expect(compiledFunctions(events)).not.toContain("AudioAttachmentRow");
  });

  it("applies the compiler to the shared components and the thread and launch surfaces", () => {
    for (const file of [
      "src/components/AppText.tsx",
      "src/components/ProjectFavicon.tsx",
      "src/features/inbox/InboxThreadRow.tsx",
      "src/features/threads/ThreadDetailScreen.tsx",
      "src/features/threads/ThreadMessage.tsx",
      "src/features/threads/ThreadComposer.tsx",
    ]) {
      expect({
        file,
        compiled: COMPILER_RUNTIME.test(transformWithAppConfig(file).code ?? ""),
      }).toEqual({ file, compiled: true });
    }
    // Directories outside the allowlist stay uncompiled until profiled.
    expect(
      COMPILER_RUNTIME.test(
        transformWithAppConfig("src/features/settings/SettingsRouteScreen.tsx").code ?? "",
      ),
    ).toBe(false);
  });

  it("never caches a connection read, or the clock once per instance, in a compiled directory", () => {
    // A cached connection read keeps a screen opened before its node connected
    // without the api until it remounts; a clock read cached on first render
    // evaluates every later change against the time the screen opened.
    const files = [
      "src/components",
      "src/features/home",
      "src/features/inbox",
      "src/features/projects",
      "src/features/threads",
    ].flatMap(sourceFiles);
    expect(files).toContain(join("src", "features", "threads", "ThreadDetailScreen.tsx"));
    expect(files.flatMap((file) => cachedImpureReads(file))).toEqual([]);
  });

  it("keeps the compiler runtime a module-level require under inline requires", async () => {
    const metroConfig = require(METRO_CONFIG) as {
      readonly transformer: {
        readonly getTransformOptions: () => Promise<{
          readonly transform: { readonly nonInlinedRequires: ReadonlyArray<string> };
        }>;
      };
    };
    const { transform } = await metroConfig.transformer.getTransformOptions();
    const file = "src/features/inbox/InboxThreadRow.tsx";
    const compiled = transformWithAppConfig(file);
    // The two Metro worker plugins that implement `experimentalImportSupport`
    // and `inlineRequires`, configured the way the worker configures them.
    const output = babel.transformFromAstSync(compiled.ast, undefined, {
      filename: join(APP, file),
      babelrc: false,
      configFile: false,
      plugins: [
        [
          metroPlugins.importExportPlugin,
          { importDefault: "_$$_IMPORT_DEFAULT", importAll: "_$$_IMPORT_ALL", resolve: false },
        ],
        [
          metroPlugins.inlineRequiresPlugin,
          {
            ignoredRequires: transform.nonInlinedRequires,
            inlineableCalls: ["_$$_IMPORT_DEFAULT", "_$$_IMPORT_ALL"],
          },
        ],
      ],
    });
    const runtimeLines = (output?.code ?? "")
      .split("\n")
      .filter((line) => line.includes("react/compiler-runtime"))
      .map((line) => line.trim());

    expect(runtimeLines).toEqual([
      expect.stringMatching(/^var \w+ = require\("react\/compiler-runtime"\);$/u),
    ]);
  });
});
