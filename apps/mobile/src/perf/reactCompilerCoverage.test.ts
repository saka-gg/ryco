// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  MOBILE_APP_DIR as APP,
  MOBILE_BABEL_CONFIG as BABEL_CONFIG,
  BABEL_PRESET_EXPO as PRESET,
  metroBabelCaller,
  requireFromBabelPreset,
  requireFromMetro,
} from "../../test/metroBabel";

/**
 * React Compiler coverage of the mobile app, asserted over the real Babel
 * transform.
 *
 * Every file under `src` is compiled (babel.config.js). The compiler silently
 * skips any function it cannot model (release builds run it with
 * `panicThreshold: "NONE"`), and Vitest never runs it, so a try/finally in a
 * handler quietly puts a screen back to re-rendering everything on every
 * streamed token. The ratchet below fails instead. Compiler 1.0 also changes
 * what some code means: it keys a memo on what its body reads, so a render-time
 * read of a store, a dependency the callback never reads and a `void x;`
 * re-render trigger all go stale. Those are checked here too.
 */

const require = createRequire(import.meta.url);
const METRO_CONFIG = join(APP, "metro.config.js");

/**
 * Functions the React Compiler leaves uncompiled today. They still ship, just
 * unmemoized. This list only shrinks: the test fails on a bailout that is not
 * listed and on a listed function that compiles now, so delete the entry (and
 * that function's manual useMemo/useCallback/memo) in the change that fixes it.
 * A deliberate opt-out is a "use no memo" directive plus an entry here; a file
 * with a module-level directive is listed under "(file)". The reasons are
 * documentation only: the test compares names.
 */
const KNOWN_BAILOUTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "src/components/OverlayPortal.tsx": {
    OverlayPortal: "increments a module counter in a useState initializer",
  },
  "src/features/connection/ConnectionsNewRouteScreen.tsx": {
    ConnectionsNewRouteScreen: "try/finally in a handler",
  },
  "src/features/e2ee/E2eeNodeVerificationRouteScreen.tsx": {
    E2eeNodeVerificationRouteScreen: "throw inside try/catch, and try/finally",
  },
  "src/features/files/ThreadFileScreen.tsx": {
    SourceLineText: "reassigns a variable after render",
  },
  "src/features/hostedHub/HostedAccountRouteScreen.tsx": {
    HostedAccountRouteScreen: "reads a ref during render",
  },
  "src/features/hostedHub/useSettledHostedStatus.ts": {
    useSettledHostedStatus: "`??=` on a ref, and feeds its tracker during render",
  },
  "src/features/identity/NativeIdentityScreen.tsx": {
    NativeIdentityScreen: "a react-hooks ESLint rule is suppressed",
  },
  "src/features/nodes/DeviceIconPicker.tsx": {
    DeviceIconPicker: "try/finally, and a dynamic import()",
  },
  "src/features/nodes/NodesScreen.tsx": { NodesScreen: "try/finally in a handler" },
  "src/features/projects/AddProjectRouteScreen.tsx": {
    AddProjectRouteScreen: "try/finally in a handler",
  },
  "src/features/projects/ProjectDetailScreen.tsx": {
    ProjectDetailScreen: "try/finally in a handler",
  },
  "src/features/review/useReviewDiffData.ts": {
    useCheckpointDiff: "a react-hooks ESLint rule is suppressed",
  },
  "src/features/settings/DeviceCacheStorage.tsx": {
    DeviceCacheStorage: "a conditional value inside try/catch",
  },
  "src/features/settings/HubDomainEditor.tsx": { HubDomainEditor: "try/finally in a handler" },
  "src/features/settings/NodeStorageSettings.tsx": { NodeStoragePanel: "try/finally in a handler" },
  "src/features/settings/SettingsHubRouteScreen.tsx": {
    SettingsHubRouteScreen: "try/finally in a handler",
  },
  "src/features/sourceControl/SourceControlRouteScreen.tsx": {
    SourceControlRouteScreen: "a react-hooks ESLint rule is suppressed",
  },
  "src/features/threads/ThreadMessage.tsx": {
    AudioAttachmentRow: "mutates the audio player its hook returns",
  },
  "src/native/ComposerEditor.ios.tsx": { ComposerEditor: "reads refs during render" },
  "src/native/ComposerEditor.native.tsx": { ComposerEditor: "reads refs during render" },
  "src/native/StackHeader.tsx": { NativeStackScreenOptions: "reads refs during render" },
  "src/rpc/useMobileQuery.ts": { useMobileQuery: "reads a ref during render" },
};

interface Location {
  readonly line: number;
  readonly column: number;
}
interface AstNode {
  readonly type: string;
  readonly loc?: { readonly start: Location } | null;
  readonly [key: string]: unknown;
}
interface Binding {
  readonly referencePaths: ReadonlyArray<AstPath>;
}
interface AstPath {
  readonly node: AstNode;
  readonly parentPath: AstPath | null;
  readonly key: string | number | null;
  readonly listKey?: string;
  readonly scope: { readonly getBinding: (name: string) => Binding | undefined };
  readonly isReferencedIdentifier: () => boolean;
  readonly traverse: (visitors: Record<string, (path: AstPath) => void>) => void;
  readonly get: (key: string) => AstPath;
}
interface BabelResult {
  readonly code?: string | null;
  readonly ast?: unknown;
}
interface BabelCore {
  readonly transformFileSync: (filename: string, options: object) => BabelResult | null;
  readonly transformSync: (source: string, options: object) => BabelResult | null;
  readonly parseSync: (source: string, options: object) => unknown;
  readonly traverse: (ast: unknown, visitors: Record<string, (path: AstPath) => void>) => void;
  readonly transformFromAstSync: (
    ast: unknown,
    code: string | undefined,
    options: object,
  ) => BabelResult | null;
}
interface CompilerEvent {
  readonly kind: string;
  readonly fnLoc?: { readonly start: Location } | null;
  readonly fnName?: string | null;
  readonly reason?: string;
  readonly data?: unknown;
  readonly detail?: {
    readonly reason?: string;
    readonly category?: string;
    readonly options?: { readonly reason?: string; readonly category?: string };
  } | null;
}
interface ReactCompilerOptions {
  readonly sources: (filename: string) => boolean;
  readonly [key: string]: unknown;
}
interface PresetOptions {
  readonly "react-compiler": ReactCompilerOptions;
  readonly [key: string]: unknown;
}

const babel = requireFromBabelPreset("@babel/core") as BabelCore;
const metroPlugins = requireFromMetro("metro-transform-plugins") as {
  readonly importExportPlugin: unknown;
  readonly inlineRequiresPlugin: unknown;
};

// A release `expo export:embed` transform.
const RELEASE_CALLER = metroBabelCaller(false);

// The preset options exactly as babel.config.js builds them (the logger is
// added per file below).
const appBabelConfig = require(BABEL_CONFIG)({ cache() {} }) as {
  readonly presets: ReadonlyArray<readonly [string, PresetOptions]>;
};
const presetOptions = appBabelConfig.presets.find(([name]) => name === "babel-preset-expo")![1];

const SOURCE_FILES: ReadonlyArray<string> = readdirSync(join(APP, "src"), { recursive: true })
  .map(String)
  .filter((file) => /\.tsx?$/u.test(file) && !/\.(test\.tsx?|d\.ts)$/u.test(file))
  .map((file) => `src/${file.split(sep).join("/")}`)
  .toSorted();

const COMPILER_RUNTIME = /require\("react\/compiler-runtime"\)|from "react\/compiler-runtime"/u;
const BAILOUT_KINDS = new Set(["CompileError", "CompileSkip", "PipelineError"]);
const NO_MEMO_DIRECTIVES = new Set(["use no memo", "use no forget"]);

// Reads of mutable state outside React: the live connection behind an
// environment, a socket's status, the saved-environment stores, and the clock.
// In render they were re-read on every pass; in a compiled memo scope they are
// read only when the scope's inputs change.
const CONNECTION_READS = new Set([
  "readEnvironmentApi",
  "ensureEnvironmentApi",
  "readRpcClient",
  "getWsConnectionStatusForEnvironment",
  "getWsConnectionStatus",
  "getRuntime",
  "hasHydrated",
  "supervisor.read",
  "supervisor.list",
]);
const CLOCK_READS = new Set(["Date.now", "new Date", "performance.now"]);
// Skips walking the compiled output of a file that cannot contain either.
const IMPURE_READ_TEXT =
  /readEnvironmentApi|ensureEnvironmentApi|readRpcClient|getWsConnectionStatus|getRuntime|hasHydrated|supervisor|Date|performance\.now/u;
// Array methods that run their callback at once, inside the scope that calls them.
const SYNCHRONOUS_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
  "toSorted",
]);
// Effect namespaces whose `map`/`filter`/... compose a step that runs later, not now.
const DEFERRED_CALLBACK_NAMESPACES = new Set([
  "Atom",
  "Effect",
  "Layer",
  "Micro",
  "Schedule",
  "Sink",
  "Stream",
]);
const COMPONENT_OR_HOOK_NAME = /^(?:use[A-Z0-9]|[A-Z])/u;

interface FileAnalysis {
  /** Functions the compiler compiled and that ship compiled. */
  readonly compiled: ReadonlyArray<string>;
  /** Function name (or "(file)") → "<category>: <reason>". */
  readonly bailouts: ReadonlyMap<string, string>;
  readonly cachedImpureReads: ReadonlyArray<string>;
  readonly unreadMemoDependencies: ReadonlyArray<string>;
  readonly voidStatements: ReadonlyArray<string>;
}

const isFunctionNode = (node: AstNode) =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression" ||
  node.type === "ObjectMethod" ||
  node.type === "ClassMethod";

const position = (location: Location | undefined) =>
  location ? `${location.line}:${location.column}` : "?";

/** A function's name as a person would find it: its id, or what it is assigned to. */
function functionName(path: AstPath): string {
  const id = path.node.id as AstNode | null | undefined;
  if (id?.type === "Identifier") return id.name as string;
  if (path.node.type === "ObjectMethod" || path.node.type === "ClassMethod") {
    return ((path.node.key as AstNode).name as string | undefined) ?? "(anonymous)";
  }
  for (let current = path.parentPath; current; current = current.parentPath) {
    const node = current.node;
    if (node.type === "VariableDeclarator" && (node.id as AstNode).type === "Identifier") {
      return (node.id as AstNode).name as string;
    }
    if (node.type === "ExportDefaultDeclaration") return "default";
    if (node.type === "ObjectProperty") {
      return ((node.key as AstNode).name as string | undefined) ?? "(anonymous)";
    }
    // memo(function …), forwardRef(…), `… as Type`: look through the wrapper.
    if (!/^(?:CallExpression|TS\w+Expression|ParenthesizedExpression)$/u.test(node.type)) break;
  }
  return `(anonymous)@${position(path.node.loc?.start)}`;
}

function eventReason(event: CompilerEvent): string {
  // Compiler 1.0 prints the directive node into a skip's reason ("[object Object]").
  if (event.kind === "CompileSkip") return "CompileSkip: opted out with a directive";
  const detail = event.detail?.options ?? event.detail;
  const reason = detail?.reason ?? event.reason ?? (event.data ? String(event.data) : event.kind);
  return `${detail?.category ?? event.kind}: ${reason}`;
}

function memberPath(node: AstNode): string | null {
  if (node.type === "Identifier") return node.name as string;
  if (
    (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
    node.computed !== true
  ) {
    const object = memberPath(node.object as AstNode);
    return object === null ? null : `${object}.${(node.property as AstNode).name as string}`;
  }
  return null;
}

/** The longest member chain `path` heads, e.g. `store.items` for the `store` in `store.items[0]`. */
function outermostMember(path: AstPath): AstPath {
  let current = path;
  while (
    current.parentPath &&
    /^(?:Optional)?MemberExpression$/u.test(current.parentPath.node.type) &&
    current.key === "object" &&
    current.parentPath.node.computed !== true
  ) {
    current = current.parentPath;
  }
  return current;
}

/** `void x;` or a bare `x;`: the compiler deletes the statement, so it reads nothing. */
function isDiscarded(path: AstPath): boolean {
  const parent = path.parentPath?.node;
  return (
    parent?.type === "ExpressionStatement" ||
    (parent?.type === "UnaryExpression" && parent.operator === "void")
  );
}

function hookCallName(node: AstNode): string | null {
  const callee = node.callee as AstNode;
  const name =
    callee.type === "Identifier"
      ? (callee.name as string)
      : callee.type === "MemberExpression" && (callee.object as AstNode).name === "React"
        ? ((callee.property as AstNode).name as string)
        : null;
  return name === "useMemo" || name === "useCallback" ? name : null;
}

/** Source-level checks: memo dependencies the callback never reads, and `void x;` triggers. */
function sourceChecks(
  file: string,
  ast: unknown,
): Pick<FileAnalysis, "unreadMemoDependencies" | "voidStatements"> {
  const unreadMemoDependencies: string[] = [];
  const voidStatements: string[] = [];
  const line = (path: AstPath) => path.node.loc?.start.line ?? "?";
  babel.traverse(ast, {
    CallExpression(path) {
      const hook = hookCallName(path.node);
      const [callback, dependencies] = path.node.arguments as ReadonlyArray<AstNode | undefined>;
      if (!hook || !callback || dependencies?.type !== "ArrayExpression") return;
      // `useCallback(onPress, [onPress])`: a callback passed by name reads itself
      // (a traversal never visits the node it starts from).
      const reads: string[] = [memberPath(callback)].filter((read) => read !== null);
      path.get("arguments.0").traverse({
        // `<Icon />` reads `Icon`, `<Icons.Close />` reads `Icons`; host tags
        // and attribute names are not references.
        JSXIdentifier(identifier) {
          if (identifier.isReferencedIdentifier()) reads.push(identifier.node.name as string);
        },
        Identifier(identifier) {
          if (!identifier.isReferencedIdentifier()) return;
          const member = outermostMember(identifier);
          if (isDiscarded(member)) return;
          const read = memberPath(member.node);
          // A method call depends on its receiver, not on the method.
          const parent = member.parentPath?.node;
          const isCallee =
            parent?.type.endsWith("CallExpression") === true && parent.callee === member.node;
          reads.push(
            isCallee && read?.includes(".") ? read.slice(0, read.lastIndexOf(".")) : read!,
          );
        },
      });
      for (const element of dependencies.elements as ReadonlyArray<AstNode | null>) {
        const dependency = element ? memberPath(element) : null;
        if (dependency === null) continue;
        const isRead = reads.some(
          (read) =>
            read === dependency ||
            read.startsWith(`${dependency}.`) ||
            dependency.startsWith(`${read}.`),
        );
        if (!isRead) {
          unreadMemoDependencies.push(
            `${file}:${line(path)}: ${hook} dependency '${dependency}' is never read; React Compiler drops it`,
          );
        }
      }
    },
    ExpressionStatement(path) {
      const expression = path.node.expression as AstNode;
      if (expression.type !== "UnaryExpression" || expression.operator !== "void") return;
      const target = memberPath(expression.argument as AstNode);
      if (target === null) return;
      let enclosing = path.parentPath;
      while (enclosing && !isFunctionNode(enclosing.node)) enclosing = enclosing.parentPath;
      if (!enclosing) return;
      const owner = enclosing.parentPath?.node;
      const inMemoCallback =
        owner?.type === "CallExpression" &&
        hookCallName(owner) !== null &&
        enclosing.key === 0 &&
        enclosing.listKey === "arguments";
      const name = functionName(enclosing);
      if (inMemoCallback || COMPONENT_OR_HOOK_NAME.test(name)) {
        voidStatements.push(
          `${file}:${line(path)}: \`void ${target};\` in ${inMemoCallback ? "a memo callback" : name} is deleted by React Compiler, so it invalidates nothing`,
        );
      }
    },
  });
  return { unreadMemoDependencies, voidStatements };
}

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

function isSynchronousCallbackArgument(path: AstPath): boolean {
  const call = path.parentPath?.node;
  if (call?.type !== "CallExpression" || path.listKey !== "arguments") return false;
  const callee = call.callee as AstNode;
  if (!/^(?:Optional)?MemberExpression$/u.test(callee.type)) return false;
  const receiver =
    (callee.object as AstNode).type === "Identifier" ? (callee.object as AstNode).name : null;
  const method = (callee.property as AstNode).name as string;
  // `Array.from(items, mapFn)` maps at once; `Effect.map(fn)` and the like only
  // describe a step that runs later.
  if (receiver === "Array") return method === "from" && path.key === 1;
  return (
    SYNCHRONOUS_CALLBACK_METHODS.has(method) &&
    !DEFERRED_CALLBACK_NAMESPACES.has(receiver as string)
  );
}

/**
 * Where a compiled function runs at once: as an array-method callback or by a
 * direct call, inline or through the binding the compiler hoisted it into
 * (`t6 = row => …; rows.map(t6)`, or a module-level `function _temp`). An event
 * handler, an effect or a `useSyncExternalStore` getter has none.
 */
function synchronousCallSites(fn: AstPath): ReadonlyArray<AstPath> {
  const parent = fn.parentPath;
  if (!parent) return [];
  if (isSynchronousCallbackArgument(fn)) return [parent];
  const bound =
    fn.node.type === "FunctionDeclaration"
      ? (fn.node.id as AstNode | null)
      : parent.node.type === "AssignmentExpression" && fn.key === "right"
        ? (parent.node.left as AstNode)
        : parent.node.type === "VariableDeclarator" && fn.key === "init"
          ? (parent.node.id as AstNode)
          : null;
  if (bound?.type !== "Identifier") return [];
  const binding = parent.scope.getBinding(bound.name as string);
  return (binding?.referencePaths ?? []).flatMap((reference) => {
    const call = reference.parentPath;
    if (!call) return [];
    if (isSynchronousCallbackArgument(reference)) return [call];
    return call.node.type === "CallExpression" && reference.key === "callee" ? [call] : [];
  });
}

/** The compiled memo scopes a call runs in, following functions to where they run. */
function enclosingCacheScopes(path: AstPath, depth = 0): ReadonlySet<"inputs" | "sentinel"> {
  let child = path;
  for (let current = path.parentPath; current; child = current, current = current.parentPath) {
    if (isFunctionNode(current.node)) {
      if (depth > 8) return new Set();
      const scopes = new Set<"inputs" | "sentinel">();
      for (const site of synchronousCallSites(current)) {
        for (const scope of enclosingCacheScopes(site, depth + 1)) scopes.add(scope);
      }
      return scopes;
    }
    if (current.node.type === "IfStatement" && child.key === "consequent") {
      const kind = cacheScopeKind(current.node.test as AstNode);
      if (kind) return new Set([kind]);
    }
  }
  return new Set();
}

function calleeName(node: AstNode): string | null {
  const callee = node.callee as AstNode;
  // Babel's CommonJS output calls imports as `(0, _module.name)(…)`.
  const target =
    callee.type === "SequenceExpression"
      ? (callee.expressions as ReadonlyArray<AstNode>).at(-1)!
      : callee;
  if (target.type === "Identifier") return target.name as string;
  if (!/^(?:Optional)?MemberExpression$/u.test(target.type)) return null;
  const object = target.object as AstNode;
  const property = (target.property as AstNode).name as string;
  if (object.type === "Identifier" && object.name === "Date") return `Date.${property}`;
  if (object.type === "Identifier" && object.name === "performance")
    return `performance.${property}`;
  if (
    (object.type === "MemberExpression" && (object.property as AstNode).name === "supervisor") ||
    (object.type === "Identifier" && object.name === "supervisor")
  ) {
    return `supervisor.${property}`;
  }
  return property;
}

/** Connection reads in any compiled memo scope, and clock reads cached once per instance. */
function cachedImpureReads(file: string, compiledAst: unknown): ReadonlyArray<string> {
  const found: string[] = [];
  const visit = (path: AstPath) => {
    const name =
      path.node.type === "NewExpression"
        ? (path.node.callee as AstNode).name === "Date"
          ? "new Date"
          : null
        : calleeName(path.node);
    if (name === null || (!CONNECTION_READS.has(name) && !CLOCK_READS.has(name))) return;
    const scopes = enclosingCacheScopes(path);
    const cached = CONNECTION_READS.has(name)
      ? [...scopes][0]
      : scopes.has("sentinel") && "sentinel";
    if (cached) {
      found.push(
        `${file}:${path.node.loc?.start.line ?? "?"}: ${name} cached in a ${cached}-keyed memo scope`,
      );
    }
  };
  babel.traverse(compiledAst, { CallExpression: visit, NewExpression: visit });
  return found;
}

/**
 * Compiles one source the way a release build does, with a logger, and runs
 * every check over it. `file` is the path relative to `apps/mobile`; it only
 * has to exist for the Babel config's `sources` scope, not on disk.
 */
function analyzeSource(file: string, source: string): FileAnalysis {
  const events: CompilerEvent[] = [];
  const filename = join(APP, file);
  const result = babel.transformSync(source, {
    filename,
    cwd: APP,
    babelrc: false,
    configFile: false,
    caller: RELEASE_CALLER,
    ast: true,
    code: false,
    presets: [
      [
        PRESET,
        {
          ...presetOptions,
          "react-compiler": {
            ...presetOptions["react-compiler"],
            logger: { logEvent: (_filename: string, event: CompilerEvent) => events.push(event) },
          },
        },
      ],
    ],
  });
  // No component or hook in the file: nothing compiles, and there is no memo
  // or render body for the source checks to look at.
  if (events.length === 0) {
    return {
      compiled: [],
      bailouts: new Map(),
      cachedImpureReads: [],
      unreadMemoDependencies: [],
      voidStatements: [],
    };
  }
  const sourceAst = babel.parseSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
  }) as { readonly program: { readonly directives: ReadonlyArray<AstNode> } };

  // Compiler 1.0 reports a compiled or failed function at `fn.loc`, but a
  // function-level opt-out at `fn.body.loc`: index both. Only a block body can
  // hold a directive, and only a block body cannot start where another
  // function does (`() => () => …`).
  const names = new Map<string, string>();
  babel.traverse(sourceAst, {
    Function(path) {
      const name = functionName(path);
      const body = path.node.body as AstNode;
      names.set(position(path.node.loc?.start), name);
      if (body.type === "BlockStatement") names.set(position(body.loc?.start), name);
    },
  });
  const nameOf = (event: CompilerEvent) =>
    event.fnLoc
      ? (names.get(position(event.fnLoc.start)) ?? `?@${position(event.fnLoc.start)}`)
      : "(file)";

  const bailouts = new Map<string, string>();
  const checks = sourceChecks(file, sourceAst);
  // A module-level "use no memo" still logs every function as compiled (and an
  // invariant error when there are any), then ships them all uncompiled.
  const moduleDirective = sourceAst.program.directives
    .map((directive) => (directive.value as AstNode).value as string)
    .find((value) => NO_MEMO_DIRECTIVES.has(value));
  if (moduleDirective) {
    bailouts.set("(file)", `CompileSkip: module-level '${moduleDirective}'`);
    return { compiled: [], bailouts, cachedImpureReads: [], ...checks };
  }
  for (const event of events) {
    if (!BAILOUT_KINDS.has(event.kind)) continue;
    const name = nameOf(event);
    const reasons = bailouts.get(name);
    const reason = eventReason(event);
    bailouts.set(name, reasons && !reasons.includes(reason) ? `${reasons}; ${reason}` : reason);
  }
  const compiled = events
    .filter((event) => event.kind === "CompileSuccess")
    .map(nameOf)
    .filter((name) => !bailouts.has(name));
  return {
    compiled,
    bailouts,
    cachedImpureReads:
      compiled.length > 0 && IMPURE_READ_TEXT.test(source)
        ? cachedImpureReads(file, result?.ast)
        : [],
    ...checks,
  };
}

// One transform and one parse per file, computed once for every test that
// needs it; only the results are kept, not the ASTs.
let analyses: ReadonlyMap<string, FileAnalysis> | undefined;
function analysis(): ReadonlyMap<string, FileAnalysis> {
  analyses ??= new Map(
    SOURCE_FILES.map((file) => [file, analyzeSource(file, readFileSync(join(APP, file), "utf8"))]),
  );
  return analyses;
}

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

const metroConfig = require(METRO_CONFIG) as {
  readonly transformer: {
    readonly babelTransformerPath: string;
    readonly enableBabelRCLookup?: boolean;
    readonly getTransformOptions: () => Promise<{
      readonly transform: { readonly nonInlinedRequires: ReadonlyArray<string> };
    }>;
  };
};

describe("mobile React Compiler coverage", () => {
  // One transform per source file: about 10 s on an idle Mac, several times
  // that on a loaded CI runner or a machine shared with other builds.
  beforeAll(() => {
    analysis();
  }, 240_000);

  it("applies the compiler to every app source file and nothing outside src", () => {
    const { sources } = presetOptions["react-compiler"];
    expect(SOURCE_FILES).toContain("src/features/settings/SettingsRouteScreen.tsx");
    expect(SOURCE_FILES.filter((file) => !sources(join(APP, file)))).toEqual([]);
    for (const file of [
      "index.ts",
      "polyfills.ts",
      "modules/ryco-markdown-text/index.ts",
      "../../packages/client-runtime/src/state/threads/store.ts",
    ]) {
      expect({ file, compiled: sources(join(APP, file)) }).toEqual({ file, compiled: false });
    }
    // Read as text: importing app.config.ts mutates process.env.
    expect(readFileSync(join(APP, "app.config.ts"), "utf8")).toMatch(
      /experiments: \{\s*reactCompiler: true/u,
    );
  });

  it("compiles app sources in Metro's babel transformer only with experiments.reactCompiler", () => {
    // Metro extends babel.config.js (and with it the `sources` scope) only
    // while Babel config lookup is on; `false` would compile every file and
    // test a config no build uses. Expo leaves it undefined.
    expect(metroConfig.transformer.enableBabelRCLookup).not.toBe(false);
    const transformer = require(metroConfig.transformer.babelTransformerPath) as {
      readonly transform: (input: object) => { readonly ast: { readonly program: unknown } };
    };
    const file = "src/features/settings/SettingsRouteScreen.tsx";
    const compiled = (reactCompiler: "true" | "false") =>
      JSON.stringify(
        transformer.transform({
          filename: join(APP, file),
          src: readFileSync(join(APP, file), "utf8"),
          plugins: [],
          options: {
            dev: false,
            hot: false,
            platform: "ios",
            projectRoot: APP,
            type: "module",
            enableBabelRCLookup: metroConfig.transformer.enableBabelRCLookup,
            experimentalImportSupport: false,
            customTransformOptions: { reactCompiler },
          },
        }).ast.program,
      ).includes("react/compiler-runtime");

    expect({ on: compiled("true"), off: compiled("false") }).toEqual({ on: true, off: false });
  });

  it("bails out only in the listed functions", () => {
    const problems: string[] = [];
    const current: Record<string, Record<string, string>> = {};
    for (const [file, { bailouts }] of analysis()) {
      const listed = KNOWN_BAILOUTS[file] ?? {};
      for (const [name, reason] of bailouts) {
        (current[file] ??= {})[name] = listed[name] ?? reason;
        if (!(name in listed)) problems.push(`new bailout: ${file} › ${name}: ${reason}`);
      }
      for (const name of Object.keys(listed)) {
        if (!bailouts.has(name)) {
          problems.push(`compiles now: ${file} › ${name} (delete its KNOWN_BAILOUTS entry)`);
        }
      }
    }
    for (const file of Object.keys(KNOWN_BAILOUTS)) {
      if (!analysis().has(file)) problems.push(`no such file: ${file}`);
    }
    if (problems.length > 0) {
      console.error(
        `Current React Compiler bailouts (fix the new ones, or list them with a reason):\n${JSON.stringify(current, null, 2)}`,
      );
    }
    expect(problems).toEqual([]);
    expect(
      Object.values(KNOWN_BAILOUTS)
        .flatMap((entries) => Object.values(entries))
        .filter((reason) => reason.trim() === ""),
    ).toEqual([]);
  });

  it.each([
    ["src/features/threads/ThreadDetailScreen.tsx", ["ThreadDetailScreen", "TimelineRow"]],
    ["src/features/threads/ThreadComposer.tsx", ["ThreadComposer"]],
    ["src/features/threads/useThreadChecks.ts", ["useThreadChecks"]],
    // The header and task sheet re-render with every watch change the shell brings.
    ["src/features/threads/ThreadContextBar.tsx", ["ThreadContextBar", "PullRequestWatchChip"]],
    [
      "src/features/threads/ThreadActionsSheet.tsx",
      ["ThreadActionsSheet", "PullRequestWatchSection"],
    ],
    ["src/features/threads/usePullRequestWatchControl.ts", ["usePullRequestWatchControl"]],
    ["src/features/threads/ThreadActivityFoldRow.tsx", ["ThreadActivityFoldRow"]],
    ["src/features/threads/PendingApprovalCard.tsx", ["PendingApprovalCard"]],
    ["src/features/threads/PendingUserInputCard.tsx", ["PendingUserInputCard"]],
    ["src/features/threads/AgentControlProposalCard.tsx", ["AgentControlProposalCard"]],
    [
      "src/features/threads/ThreadMessage.tsx",
      ["ThreadMessage", "ImageAttachment", "VideoAttachmentRow"],
    ],
    ["src/features/inbox/InboxThreadRow.tsx", ["InboxThreadRow"]],
    ["src/components/AppText.tsx", ["AppText"]],
    ["src/components/ProjectFavicon.tsx", ["ProjectFavicon"]],
    // Hooks the thread screen calls on every render, compiled since the whole
    // of src is: their results are now stable between renders.
    ["src/state/threadTimeline.ts", ["useThreadTimeline"]],
    ["src/state/homeData.ts", ["useHomeWorkspaceData"]],
    ["src/state/environmentServerConfigs.ts", ["useEnvironmentServerConfigs"]],
    ["src/state/agentControlSync.ts", ["useAgentControlSync"]],
    ["src/connection/useThreadConnectionRetarget.ts", ["useThreadConnectionRetarget"]],
    ["src/lib/useThemeColor.ts", ["useThemeColor"]],
    ["src/features/newTask/useNewTaskRepository.ts", ["useRepositoryStatus"]],
    ["src/features/connection/useConnectionController.ts", ["useSavedEnvironments"]],
    ["src/features/connection/useSavedEnvironmentSnapshots.ts", ["useSavedEnvironmentSnapshots"]],
    ["src/state/useWorkspaceState.ts", ["useWorkspaceState"]],
    ["src/Stack.tsx", ["RootStackLayout"]],
    [
      "src/features/keyboard/HardwareKeyboardCommandProvider.tsx",
      ["HardwareKeyboardCommandProvider"],
    ],
  ])("compiles the hot render path in %s", (file, expected) => {
    expect(analysis().get(file)?.compiled).toEqual(expect.arrayContaining(expected));
  });

  it("never caches a connection read, or the clock once per instance", () => {
    // A cached connection read keeps a screen opened before its node connected
    // without the api until it remounts, and a node that dropped showing
    // "connected"; a clock read cached on first render evaluates every later
    // change against the time the screen opened. Subscribe instead
    // (useEnvironmentApi, useWsConnectionStatusesForEnvironments, ...).
    expect([...analysis().values()].flatMap((file) => file.cachedImpureReads)).toEqual([]);
  });

  it("never lists a manual memo dependency its callback does not read", () => {
    // Compiler 1.0 replaces useMemo/useCallback dependencies with the values
    // the callback reads, so a "version key" listed but never read is dropped
    // and the memo goes stale. Read the value itself, or subscribe to a
    // snapshot that changes with it.
    expect([...analysis().values()].flatMap((file) => file.unreadMemoDependencies)).toEqual([]);
  });

  it("never uses `void x;` as a re-render trigger in a component, hook or memo", () => {
    // The compiler deletes the statement, so whatever the value was meant to
    // invalidate is cached on the remaining inputs.
    expect([...analysis().values()].flatMap((file) => file.voidStatements)).toEqual([]);
  });

  it("keeps the compiler runtime a module-level require under inline requires", async () => {
    const { transform } = await metroConfig.transformer.getTransformOptions();
    const file = "src/features/inbox/InboxThreadRow.tsx";
    const compiled = transformWithAppConfig(file);
    expect(COMPILER_RUNTIME.test(compiled.code ?? "")).toBe(true);
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

// The checks above only mean something if they see what they claim to see. Each
// fixture is compiled in memory, as if it lived at `file`.
describe("the coverage checks themselves", () => {
  const fixture = (source: string, file = "src/__coverage_fixture__.tsx") =>
    analyzeSource(file, source);

  it("names a function-level opt-out, and keeps its neighbours compiled", () => {
    const result = fixture(`
      import { useState } from "react";
      export function OptedOut() {
        "use no memo";
        const [count] = useState(0);
        return <>{count}</>;
      }
      export const Compiled = () => {
        const [count] = useState(0);
        return <>{count}</>;
      };
    `);
    expect([...result.bailouts.keys()]).toEqual(["OptedOut"]);
    expect(result.bailouts.get("OptedOut")).toBe("CompileSkip: opted out with a directive");
    expect(result.compiled).toEqual(["Compiled"]);
  });

  it("reports a module-level opt-out as one file entry with nothing compiled", () => {
    const result = fixture(`
      "use no memo";
      import { useState } from "react";
      export function Screen() {
        const [count] = useState(0);
        return <>{count}</>;
      }
    `);
    expect([...result.bailouts.keys()]).toEqual(["(file)"]);
    expect(result.compiled).toEqual([]);
  });

  it("names a function the compiler cannot model", () => {
    const result = fixture(`
      import { useState } from "react";
      export function Busy() {
        const [busy, setBusy] = useState(false);
        const run = async () => {
          setBusy(true);
          try { await Promise.resolve(); } finally { setBusy(false); }
        };
        return <View onPress={run}>{busy ? "…" : null}</View>;
      }
    `);
    expect([...result.bailouts.keys()]).toEqual(["Busy"]);
  });

  it("follows a status read into array callbacks, inline or hoisted, but not into effects", () => {
    const result = fixture(`
      import { useEffect } from "react";
      import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
      export function useRows(ids, labels) {
        const inline = ids.map((id) => getWsConnectionStatusForEnvironment(id).phase);
        const named = ids.map((id) => ({ label: labels[id], status: getWsConnectionStatusForEnvironment(id) }));
        useEffect(() => {
          for (const id of ids) getWsConnectionStatusForEnvironment(id);
        }, [ids]);
        return [inline, named];
      }
    `);
    expect(result.cachedImpureReads).toHaveLength(2);
    expect(result.cachedImpureReads.every((read) => read.includes("inputs-keyed"))).toBe(true);
  });

  it("follows Array.from's map callback, but not an Effect step that runs later", () => {
    const result = fixture(`
      import { useState } from "react";
      import * as Effect from "effect/Effect";
      import { readEnvironmentApi, getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
      export function useStatuses(ids, id, source) {
        const [label] = useState("statuses");
        const eager = Array.from(ids, (each) => getWsConnectionStatusForEnvironment(each));
        const deferred = source.pipe(Effect.map(() => readEnvironmentApi(id)));
        return [label, eager, deferred];
      }
    `);
    expect(result.cachedImpureReads).toHaveLength(1);
    expect(result.cachedImpureReads[0]).toContain("getWsConnectionStatusForEnvironment");
  });

  it("counts a callback passed by name and a JSX tag as reads of their dependency", () => {
    const result = fixture(`
      import { useCallback, useMemo } from "react";
      export function Row({ Icon, Icons, onPress }) {
        const press = useCallback(onPress, [onPress]);
        const icon = useMemo(() => <Icon size={12} />, [Icon]);
        const close = useMemo(() => <Icons.Close />, [Icons.Close]);
        return <View onPress={press}>{icon}{close}</View>;
      }
    `);
    expect(result.unreadMemoDependencies).toEqual([]);
  });

  it("flags unread memo dependencies by member path, and `void` triggers", () => {
    const result = fixture(`
      import { useMemo } from "react";
      export function useItems(store, version) {
        void version;
        const items = useMemo(() => store.items.slice(), [store.version]);
        const all = useMemo(() => {
          void version;
          return store.items.concat(items);
        }, [store, items, version]);
        return all;
      }
    `);
    expect(
      result.unreadMemoDependencies.map((entry) => entry.split(": ").slice(1).join(": ")),
    ).toEqual([
      "useMemo dependency 'store.version' is never read; React Compiler drops it",
      "useMemo dependency 'version' is never read; React Compiler drops it",
    ]);
    expect(result.voidStatements).toHaveLength(2);
  });
});
