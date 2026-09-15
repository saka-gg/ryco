import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse, type AnyNode } from "acorn";

export interface RuntimeImport {
  readonly specifier: string;
  readonly kind: "import" | "require";
}

/** Scan generated JS, not sources or dependency internals (which have optional/platform imports). */
export function collectRuntimeImports(source: string): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  const add = (value: unknown, kind: RuntimeImport["kind"]) => {
    if (typeof value === "string") imports.push({ specifier: value, kind });
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as AnyNode;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        add(node.source?.value, "import");
        break;
      case "ImportExpression":
        if (node.source.type === "Literal") add(node.source.value, "import");
        break;
      case "CallExpression":
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          const argument = node.arguments[0];
          if (argument?.type === "Literal") add(argument.value, "require");
        }
        break;
    }
    Object.values(value).forEach(visit);
  };
  visit(
    parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
    }),
  );
  return imports;
}

// Use Node's actual import/require export conditions without evaluating application modules.
// One process handles the entire batch. The explicit parent is enabled by the Node flag below.
const resolveImportsScript = `
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const { stageRoot, imports } = JSON.parse(readFileSync(0, "utf8"));
const errors = [];
for (const { importer, specifier, kind } of imports) {
  try {
    const parent = pathToFileURL(importer);
    const resolved = kind === "require"
      ? createRequire(parent).resolve(specifier)
      : fileURLToPath(import.meta.resolve(specifier, parent.href));
    const actual = realpathSync(resolved);
    const local = relative(stageRoot, actual);
    if (local === ".." || local.startsWith("../") || local.startsWith("..\\\\") || isAbsolute(local)) {
      throw new Error("resolves outside the staged app: " + actual);
    }
    if (!statSync(actual).isFile()) throw new Error("resolved target is not a file");
  } catch (error) {
    errors.push(relative(stageRoot, importer) + " -> " + specifier + ": " + error.message);
  }
}
process.stdout.write(JSON.stringify(errors));
`;

/** Checks only the emitted desktop/backend JS, including lazy chunks, inside a clean stage. */
export function validateStagedRuntimeDependencies(stageAppDir: string): number {
  const stageRoot = realpathSync(stageAppDir);
  const imports: (RuntimeImport & { importer: string })[] = [];
  for (const [directory, entry, extension, electron] of [
    ["apps/desktop/dist-electron", "main.cjs", ".cjs", true],
    // The desktop backend launches bin.mjs. The alternate CJS server build is not executed.
    ["apps/server/dist", "bin.mjs", ".mjs", false],
  ] as const) {
    const outputDir = join(stageRoot, directory);
    if (!existsSync(join(outputDir, entry)))
      throw new Error(`Missing staged entry: ${directory}/${entry}`);
    for (const name of readdirSync(outputDir).toSorted()) {
      if (!name.endsWith(extension)) continue;
      const importer = join(outputDir, name);
      for (const imported of collectRuntimeImports(readFileSync(importer, "utf8"))) {
        if (isBuiltin(imported.specifier) || (electron && imported.specifier === "electron"))
          continue;
        imports.push({ ...imported, importer });
      }
    }
  }
  const errors = JSON.parse(
    execFileSync(
      process.execPath,
      ["--experimental-import-meta-resolve", "--input-type=module", "--eval", resolveImportsScript],
      {
        input: JSON.stringify({ stageRoot, imports }),
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      },
    ),
  ) as string[];
  if (errors.length)
    throw new Error(`Staged runtime dependencies are missing or invalid:\n${errors.join("\n")}`);
  return imports.length;
}

function isStagedFile(stageRoot: string, file: string): boolean {
  if (!existsSync(file)) return false;
  const local = relative(stageRoot, realpathSync(file));
  return (
    local !== ".." &&
    !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(local) &&
    statSync(file).isFile() &&
    statSync(file).size > 0
  );
}

/** Payload presence only, after electron-builder rebuilds addons; never an ABI/loadability claim. */
export function validateStagedNativePayloads(
  stageAppDir: string,
  platform: "darwin" | "linux" | "win32",
  arch: "arm64" | "x64" | "universal",
): void {
  const stageRoot = realpathSync(stageAppDir);
  const modules = join(stageRoot, "node_modules");
  const requirePayload = (label: string, candidates: string[]) => {
    if (!candidates.some((file) => isStagedFile(stageRoot, file))) {
      throw new Error(
        `Missing staged native payload for ${label} (${platform}/${arch}). Checked: ${candidates.map((file) => relative(stageRoot, file)).join(", ")}`,
      );
    }
  };
  for (const targetArch of arch === "universal" ? ["arm64", "x64"] : [arch]) {
    for (const [dependency, names, directories] of [
      [
        "node-pty",
        platform === "win32" ? ["conpty", "conpty_console_list"] : ["pty"],
        ["build/Release", "build/Debug", `prebuilds/${platform}-${targetArch}`],
      ],
      ["@github/keytar", ["keytar"], ["build/Release", `prebuilds/${platform}-${targetArch}`]],
    ] as const) {
      for (const name of names) {
        requirePayload(
          `${dependency}/${name}.node`,
          directories.map((directory) => join(modules, dependency, directory, `${name}.node`)),
        );
      }
    }
    // sharp's platform package contains a JS entry shim as well as the actual addon.
    // Checking require.resolve("sharp") or its shim alone misses a deleted native payload.
    const sharpDir = join(modules, `@img/sharp-${platform}-${targetArch}`, "lib");
    requirePayload(
      `sharp/${targetArch}`,
      existsSync(sharpDir)
        ? readdirSync(sharpDir)
            .filter((name) => name.endsWith(".node"))
            .map((name) => resolve(sharpDir, name))
        : [],
    );
    // Windows ships libvips DLLs alongside the addon rather than in a separate package.
    const vipsDir =
      platform === "win32"
        ? sharpDir
        : join(modules, `@img/sharp-libvips-${platform}-${targetArch}`, "lib");
    requirePayload(
      `sharp-libvips/${targetArch}`,
      existsSync(vipsDir)
        ? readdirSync(vipsDir)
            .filter((name) => /^libvips.*(?:\.(?:dylib|dll)|\.so(?:\..*)?)$/u.test(name))
            .map((name) => resolve(vipsDir, name))
        : [],
    );
  }
}
