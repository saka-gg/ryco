import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parseSync } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

/**
 * Source-level guard for the hosted capability readers.
 *
 * `useHostedRpcCapability`, `readHostedRpcCapability` and
 * `useHostedSwitchTarget` answer for one environment. The type already
 * requires the argument; this scan closes the remaining gap: `null` means "the
 * routed node", which is only right when the call site says so on purpose.
 * Every literal `null` must carry a `// hosted-capability: routed node`
 * comment on its line or on the call's line, or on the line directly above
 * either, so a call that merely forgot to name its environment cannot hide
 * behind `null`. A literal `environmentId={null}` JSX prop is held to the same
 * rule, since components forward that prop to these readers.
 *
 * The scan sees literal `null` only: a `null` that reaches a reader through a
 * variable, or through an API other than the ones above, is not visible to it.
 */

const WEB_SRC = path.resolve(import.meta.dirname, "..");
/** The callables that take an environment, and the position of that argument. */
const ENVIRONMENT_ARGUMENT_INDEX = new Map([
  ["useHostedRpcCapability", 1],
  ["readHostedRpcCapability", 1],
  ["useHostedSwitchTarget", 0],
]);
const ENVIRONMENT_PROP = "environmentId";
const ROUTED_NODE_MARKER = "hosted-capability: routed node";
/** Cheap pre-filter: files that cannot contain a checked site are not parsed. */
const CHECKED_SITE_MENTION = /HostedRpcCapability|useHostedSwitchTarget|environmentId\s*=\s*\{/;
const SKIPPED_FILE = /\.(?:test|browser|standard)\./;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "__screenshots__"]);
const SOURCE_FILE = /\.tsx?$/;
/** Wrappers that do not change which value an argument is. */
const TRANSPARENT_NODES = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface CapabilityCallProblem {
  readonly line: number;
  readonly message: string;
}

interface CapabilityCallReport {
  /** How many checked sites (calls and `environmentId` props) the source holds. */
  readonly sites: number;
  readonly problems: ReadonlyArray<CapabilityCallProblem>;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function visit(value: unknown, onNode: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, onNode);
    return;
  }
  if (!isNode(value)) return;
  onNode(value);
  for (const child of Object.values(value)) visit(child, onNode);
}

/**
 * The callable a call invokes (`name(...)` or `module.name(...)`) and where its
 * environment argument sits, if it takes an environment.
 */
function environmentCall(call: AstNode): { name: string; index: number } | null {
  const callee = call.callee;
  if (!isNode(callee)) return null;
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" && isNode(callee.property) && !callee.computed
        ? callee.property.name
        : null;
  if (typeof name !== "string") return null;
  const index = ENVIRONMENT_ARGUMENT_INDEX.get(name);
  return index === undefined ? null : { name, index };
}

function isNullLiteral(argument: AstNode): boolean {
  let current = argument;
  while (TRANSPARENT_NODES.has(current.type) && isNode(current.expression)) {
    current = current.expression;
  }
  return current.type === "Literal" && current.raw === "null";
}

/** Whether a JSX attribute is `environmentId={null}`. */
function isNullEnvironmentProp(attribute: AstNode): boolean {
  const { name, value } = attribute;
  if (!isNode(name) || name.type !== "JSXIdentifier" || name.name !== ENVIRONMENT_PROP) {
    return false;
  }
  return (
    isNode(value) &&
    value.type === "JSXExpressionContainer" &&
    isNode(value.expression) &&
    isNullLiteral(value.expression)
  );
}

/**
 * Checks every capability reader call (and `environmentId` prop) in one source
 * file: each call must name its environment, and a literal `null` must be
 * marked as deliberate.
 */
function checkCapabilityCalls(source: string, filename: string): CapabilityCallReport {
  const { program, comments, errors } = parseSync(filename, source);
  if (errors.length > 0) throw new Error(`Failed to parse ${filename}`);

  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  // A marker covers its own line, and the next line when it stands alone (a
  // trailing marker belongs to the statement it follows, not the one below). A
  // JSX comment container around the marker still counts as standing alone.
  const markers = comments
    .filter((comment) => comment.value.includes(ROUTED_NODE_MARKER))
    .map((comment) => ({
      startLine: lineOf(comment.start),
      endLine: lineOf(comment.end),
      standalone: /^[ \t]*\{?[ \t]*$/.test(
        source.slice(source.lastIndexOf("\n", comment.start - 1) + 1, comment.start),
      ),
    }));
  const isMarked = (line: number) =>
    markers.some(
      (marker) => marker.startLine === line || (marker.standalone && marker.endLine + 1 === line),
    );

  let sites = 0;
  const problems: CapabilityCallProblem[] = [];
  visit(program, (node) => {
    if (node.type === "JSXAttribute") {
      if (!isNullEnvironmentProp(node)) return;
      sites += 1;
      const line = lineOf(node.start);
      if (isMarked(line)) return;
      problems.push({
        line,
        message: `${ENVIRONMENT_PROP}={null} needs a "// ${ROUTED_NODE_MARKER}" comment`,
      });
      return;
    }
    if (node.type !== "CallExpression") return;
    const call = environmentCall(node);
    if (call === null) return;
    sites += 1;
    const line = lineOf(node.start);
    const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
    if (args.some((argument) => argument.type === "SpreadElement")) {
      problems.push({ line, message: `${call.name}: spread arguments hide the environment` });
      return;
    }
    const environment = args[call.index];
    if (environment === undefined) {
      problems.push({ line, message: `${call.name}: names no environment` });
      return;
    }
    if (!isNullLiteral(environment)) return;
    if (isMarked(line) || isMarked(lineOf(environment.start))) return;
    problems.push({
      line,
      message: `${call.name}: null needs a "// ${ROUTED_NODE_MARKER}" comment`,
    });
  });
  return { sites, problems };
}

function* webSourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* webSourceFiles(full);
      continue;
    }
    if (SOURCE_FILE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) yield full;
  }
}

describe("capability environment", () => {
  it("is named at every call in the web sources, and a routed node null is marked", () => {
    let sites = 0;
    const problems: string[] = [];
    for (const file of webSourceFiles(WEB_SRC)) {
      const source = readFileSync(file, "utf8");
      if (!CHECKED_SITE_MENTION.test(source)) continue;
      const report = checkCapabilityCalls(source, file);
      sites += report.sites;
      for (const problem of report.problems) {
        problems.push(`${path.relative(WEB_SRC, file)}:${problem.line} ${problem.message}`);
      }
    }
    // A scan that found nothing would pass vacuously.
    expect(sites).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

describe("checkCapabilityCalls", () => {
  const check = (source: string) => checkCapabilityCalls(source, "sample.tsx");

  it("accepts a call that names its environment", () => {
    expect(
      check(`
        const a = useHostedRpcCapability(METHOD, environmentId);
        const b = readHostedRpcCapability(METHOD, ref.environmentId).allowed;
        const c = useHostedRpcCapability(METHOD, environmentId ?? null);
      `),
    ).toEqual({ sites: 3, problems: [] });
  });

  it("accepts a null marked as the routed node", () => {
    expect(
      check(`
        // hosted-capability: routed node
        const above = useHostedRpcCapability(METHOD, null);
        const sameLine = readHostedRpcCapability(METHOD, null); // hosted-capability: routed node
        // hosted-capability: routed node
        const multiLine = useHostedRpcCapability(
          METHOD,
          null,
        ).allowed;
        const nullLine = useHostedRpcCapability(
          METHOD,
          // hosted-capability: routed node
          null,
        );
      `),
    ).toEqual({ sites: 4, problems: [] });
  });

  it("rejects a null without the marker and reports its line", () => {
    const report = check(`
      const a = useHostedRpcCapability(METHOD, null);
      // hosted-capability: routed node

      const b = readHostedRpcCapability(METHOD, null);
      // an unrelated comment
      const c = useHostedRpcCapability(
        METHOD,
        (null),
      );
    `);
    expect(report.sites).toBe(3);
    expect(report.problems.map((problem) => problem.line)).toEqual([2, 5, 7]);
    expect(report.problems[0]!.message).toContain("hosted-capability: routed node");
  });

  it("does not let a trailing marker cover the call below it", () => {
    const report = check(`
      const a = useHostedRpcCapability(METHOD, null); // hosted-capability: routed node
      const b = useHostedRpcCapability(METHOD, null);
    `);
    expect(report.problems.map((problem) => problem.line)).toEqual([3]);
  });

  it("rejects a call with one argument or none, however it is laid out", () => {
    const report = check(`
      const a = useHostedRpcCapability(METHOD);
      const b = readHostedRpcCapability(
        METHOD,
      );
      const c = useHostedRpcCapability();
      const d = capabilities.readHostedRpcCapability(METHOD);
    `);
    expect(report.sites).toBe(4);
    expect(report.problems.map((problem) => problem.line)).toEqual([2, 3, 6, 7]);
    expect(report.problems[0]!.message).toContain("names no environment");
  });

  it("holds the switch target hook to the same rule, with its environment first", () => {
    const report = check(`
      const named = useHostedSwitchTarget(environmentId);
      // hosted-capability: routed node
      const marked = useHostedSwitchTarget(null);
      const unmarked = useHostedSwitchTarget(null);
      const missing = useHostedSwitchTarget();
    `);
    expect(report.sites).toBe(4);
    expect(report.problems.map((problem) => problem.line)).toEqual([5, 6]);
    expect(report.problems[0]!.message).toContain("useHostedSwitchTarget: null needs");
    expect(report.problems[1]!.message).toContain("useHostedSwitchTarget: names no environment");
  });

  it("holds a literal null environmentId prop to the same rule", () => {
    const report = check(`
      const tree = (
        <>
          <Card environmentId={environmentId} />
          <Card environmentId={ref.environmentId ?? null} />
          <Card environmentId="env-1" />
          <Card other={null} />
          <Card
            // hosted-capability: routed node
            environmentId={null}
          />
          {/* hosted-capability: routed node */}
          <Card environmentId={null} />
          <Card environmentId={null} />
          <Card
            environmentId={(null)}
          />
        </>
      );
    `);
    expect(report.sites).toBe(4);
    expect(report.problems.map((problem) => problem.line)).toEqual([14, 16]);
    expect(report.problems[0]!.message).toContain("environmentId={null} needs");
  });

  it("rejects spread arguments, which hide the environment", () => {
    const report = check(`const a = readHostedRpcCapability(...args);`);
    expect(report.problems).toEqual([
      { line: 1, message: "readHostedRpcCapability: spread arguments hide the environment" },
    ]);
  });

  it("ignores definitions, mentions in comments and strings, and other calls", () => {
    expect(
      check(`
        export function useHostedRpcCapability(method: string, environmentId: string | null) {}
        // useHostedRpcCapability(METHOD) is described here
        const text = "readHostedRpcCapability(METHOD)";
        const other = useHostedWorkspaceState(null);
        const reference = useHostedRpcCapability;
      `),
    ).toEqual({ sites: 0, problems: [] });
  });

  it("finds calls inside components and nested expressions", () => {
    const report = check(`
      function Panel() {
        const items = list.map(() => <Row allowed={useHostedRpcCapability(METHOD).allowed} />);
        return items;
      }
    `);
    expect(report.problems.map((problem) => problem.line)).toEqual([3]);
  });
});
