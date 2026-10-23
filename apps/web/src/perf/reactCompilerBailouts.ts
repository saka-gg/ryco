import { transform } from "oxc-transform-react";
import { parseSync } from "vite-plus";

/**
 * What the React Compiler does with a module's functions, as the web build
 * runs it (`oxc-transform-react` through plugin-react, production JSX).
 *
 * The compiler works on top-level functions: each component or hook either
 * compiles whole or is skipped whole. Every recoverable diagnostic it reports
 * is a reason it skipped the outermost function containing it, so diagnostics
 * are grouped by that function. Test support for
 * `reactCompilerCoverage.test.ts`; the app never imports it.
 */
export interface CompilerBailout {
  /** The outermost function's name, `"default"`, `"<anonymous>"`, or `"<module>"`. */
  readonly fn: string;
  /** Unique diagnostic messages, sorted. */
  readonly reasons: ReadonlyArray<string>;
  readonly codeframes: ReadonlyArray<string>;
}

export interface ReactCompilerReport {
  /** Functions the compiler skipped. Functions that opt out are not listed. */
  readonly bailouts: ReadonlyArray<CompilerBailout>;
  /**
   * Functions that opt out with a `"use no memo"` (or `"use no forget"`)
   * directive, sorted; `"<module>"` for a module-level directive.
   */
  readonly optedOut: ReadonlyArray<string>;
  /** Functions the compiler compiled, sorted. */
  readonly compiled: ReadonlyArray<string>;
}

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface FunctionUnit {
  readonly name: string;
  readonly node: AstNode;
}

const OPT_OUT_DIRECTIVES = new Set(["use no memo", "use no forget"]);
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const MODULE = "<module>";
const ANONYMOUS = "<anonymous>";

/**
 * With a gate configured, the compiler emits every function it compiles as
 * `gate() ? compiled : original`. That marks compiled functions exactly: one
 * that needs no memo cache otherwise comes out looking unchanged. It changes
 * neither what compiles nor how (checked on every web module).
 */
const GATE = {
  source: "ryco:react-compiler-analysis",
  importSpecifierName: "isCompiledByReactCompiler",
} as const;

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function identifierName(value: unknown): string | undefined {
  return isAstNode(value) && value.type === "Identifier" && typeof value.name === "string"
    ? value.name
    : undefined;
}

function childNodes(node: AstNode): ReadonlyArray<AstNode> {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isAstNode(item)) children.push(item);
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }
  return children;
}

/** The directive prologue of a program or function body. */
function directivesOf(statements: unknown): ReadonlyArray<string> {
  if (!Array.isArray(statements)) return [];
  const directives: string[] = [];
  for (const statement of statements) {
    const directive = isAstNode(statement) ? statement.directive : undefined;
    if (typeof directive !== "string") break;
    directives.push(directive);
  }
  return directives;
}

function optsOut(statements: unknown): boolean {
  return directivesOf(statements).some((directive) => OPT_OUT_DIRECTIVES.has(directive));
}

function bodyStatements(fn: AstNode): unknown {
  return isAstNode(fn.body) && fn.body.type === "BlockStatement" ? fn.body.body : undefined;
}

/**
 * The outermost functions of a program, named the way a reader finds them:
 * the function's own name, else the variable it is assigned to (also through
 * `memo(...)` and `forwardRef(...)`), else `"default"` for a default export,
 * else `"<anonymous>"`. Names never depend on positions, so an edit elsewhere
 * in the module does not rename a `KNOWN_BAILOUTS` entry.
 */
function collectFunctionUnits(program: AstNode): ReadonlyArray<FunctionUnit> {
  const units: FunctionUnit[] = [];
  const visit = (node: AstNode, nameHint: string | undefined): void => {
    if (FUNCTION_TYPES.has(node.type)) {
      const name = identifierName(node.id) ?? nameHint ?? ANONYMOUS;
      units.push({ name, node });
      return;
    }
    let hint = nameHint;
    if (node.type === "VariableDeclarator") hint = identifierName(node.id) ?? hint;
    if (node.type === "ExportDefaultDeclaration") hint = "default";
    for (const child of childNodes(node)) visit(child, hint);
  };
  visit(program, undefined);
  return units;
}

function parseProgram(file: string, code: string, lang?: "js"): AstNode {
  const result = parseSync(file, code, lang ? { lang, sourceType: "module" } : undefined);
  if (result.errors.length > 0) {
    throw new Error(`Cannot parse ${file}: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.program as unknown as AstNode;
}

/** The local name the compiled output imports the gate as. */
function gateName(program: AstNode): string | undefined {
  for (const statement of childNodes(program)) {
    if (statement.type !== "ImportDeclaration") continue;
    if (!isAstNode(statement.source) || statement.source.value !== GATE.source) continue;
    for (const specifier of childNodes(statement)) {
      if (
        specifier.type === "ImportSpecifier" &&
        identifierName(specifier.imported) === GATE.importSpecifierName
      ) {
        return identifierName(specifier.local);
      }
    }
  }
  return undefined;
}

/** The functions that come out as the compiled branch of `gate() ? compiled : original`. */
function compiledFunctions(file: string, output: string): ReadonlyArray<string> {
  const program = parseProgram(`${file}.js`, output, "js");
  const gate = gateName(program);
  if (gate === undefined) return [];
  const compiled = new Set<AstNode>();
  const findGated = (node: AstNode): void => {
    if (
      node.type === "ConditionalExpression" &&
      isAstNode(node.test) &&
      node.test.type === "CallExpression" &&
      identifierName(node.test.callee) === gate &&
      isAstNode(node.consequent)
    ) {
      compiled.add(node.consequent);
    }
    for (const child of childNodes(node)) findGated(child);
  };
  findGated(program);
  const names = collectFunctionUnits(program)
    .filter((unit) => compiled.has(unit.node))
    .map((unit) => unit.name);
  return [...new Set(names)].toSorted();
}

/**
 * Compiles `code` (the module at `file`) the way the web build does, with the
 * compiler's diagnostics on, and reports which functions bail out, opt out
 * and compile.
 */
export async function analyzeReactCompilerModule(
  file: string,
  code: string,
): Promise<ReactCompilerReport> {
  const result = await transform(file, code, {
    jsx: { runtime: "automatic", development: false, refresh: false },
    reactCompiler: { reportDiagnostics: true, gating: GATE },
    sourcemap: false,
  });
  if (result.fatal) {
    throw new Error(
      `React Compiler failed on ${file}:\n${result.errors
        .map((error) => error.codeframe ?? error.message)
        .join("\n")}`,
    );
  }
  const compiled = compiledFunctions(file, result.code);
  const program = parseProgram(file, code);
  if (optsOut(program.body)) return { bailouts: [], optedOut: [MODULE], compiled };

  const units = collectFunctionUnits(program);
  const optedOutUnits = new Set(units.filter((unit) => optsOut(bodyStatements(unit.node))));
  // Oxc reports UTF-8 byte offsets; the parser's spans count UTF-16 code units.
  const bytes = Buffer.from(code, "utf8");
  const toCodeUnits = (byteOffset: number) => bytes.subarray(0, byteOffset).toString("utf8").length;
  const byFunction = new Map<string, { reasons: Set<string>; codeframes: string[] }>();
  for (const error of result.errors) {
    const byteOffset = error.labels[0]?.start;
    const offset = byteOffset === undefined ? undefined : toCodeUnits(byteOffset);
    const unit =
      offset === undefined
        ? undefined
        : units.find(({ node }) => node.start <= offset && offset < node.end);
    // The compiler still analyzes opted-out functions and reports what it finds.
    if (unit && optedOutUnits.has(unit)) continue;
    const name = unit?.name ?? MODULE;
    const entry = byFunction.get(name) ?? { reasons: new Set<string>(), codeframes: [] };
    entry.reasons.add(error.message);
    entry.codeframes.push(error.codeframe ?? error.message);
    byFunction.set(name, entry);
  }
  return {
    bailouts: [...byFunction]
      .map(([fn, entry]) => ({
        fn,
        reasons: [...entry.reasons].toSorted(),
        codeframes: entry.codeframes,
      }))
      .toSorted((left, right) => (left.fn < right.fn ? -1 : left.fn > right.fn ? 1 : 0)),
    optedOut: [...new Set([...optedOutUnits].map((unit) => unit.name))].toSorted(),
    compiled,
  };
}
