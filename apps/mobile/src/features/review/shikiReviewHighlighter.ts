import { createHighlighterCore, type GrammarState, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bashLanguage from "@shikijs/langs/bash";
import javascriptLanguage from "@shikijs/langs/javascript";
import jsonLanguage from "@shikijs/langs/json";
import jsxLanguage from "@shikijs/langs/jsx";
import tsxLanguage from "@shikijs/langs/tsx";
import typescriptLanguage from "@shikijs/langs/typescript";
import yamlLanguage from "@shikijs/langs/yaml";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";
import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";
import * as Schema from "effect/Schema";

import {
  resolveReviewHighlighterEngine,
  resolveReviewHighlighterEnginePreference,
} from "./reviewHighlighterEngine";

export type ReviewDiffTheme = "light" | "dark";

export class ReviewHighlighterEngineInitializationError extends Schema.TaggedError<ReviewHighlighterEngineInitializationError>()(
  "ReviewHighlighterEngineInitializationError",
  {
    preferredEngine: Schema.Literals(["native", "javascript"]),
    attemptedEngine: Schema.Literals(["native", "javascript"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the ${this.attemptedEngine} review highlighter with ${this.preferredEngine} preferred.`;
  }
}

export interface ReviewHighlightedToken {
  content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

const SHIKI_THEME_NAME_BY_SCHEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;
const REVIEW_HIGHLIGHTER_ENGINE_ENV_VALUE =
  process.env.EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE ??
  (process.env.NODE_ENV === "test" ? "javascript" : "native");
const REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE = resolveReviewHighlighterEnginePreference(
  REVIEW_HIGHLIGHTER_ENGINE_ENV_VALUE,
);
const REVIEW_HIGHLIGHT_CHUNK_LINE_THRESHOLD = 8;
const REVIEW_HIGHLIGHT_CHUNK_SIZE = 200;
const REVIEW_HIGHLIGHT_SLICE_MS = 4;

function nextHighlightChunkSize(previous: number, elapsed: number): number {
  return Math.max(
    1,
    Math.min(
      REVIEW_HIGHLIGHT_CHUNK_SIZE,
      Math.floor((previous * REVIEW_HIGHLIGHT_SLICE_MS) / Math.max(1, elapsed)),
    ),
  );
}
const REVIEW_TOKENIZE_MAX_LINE_LENGTH = 1_000;
const REVIEW_INITIAL_LANGUAGE_MODULES = [
  bashLanguage,
  javascriptLanguage,
  jsonLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
  yamlLanguage,
] satisfies Parameters<typeof createHighlighterCore>[0]["langs"];
const loadedLanguages = new Set<string>([
  "text",
  "bash",
  "javascript",
  "json",
  "jsx",
  "tsx",
  "typescript",
  "yaml",
]);
const languageLoadingPromises = new Map<string, Promise<boolean>>();
const languageImports: Partial<Record<string, () => Promise<unknown>>> = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  lua: () => import("@shikijs/langs/lua"),
  perl: () => import("@shikijs/langs/perl"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  elixir: () => import("@shikijs/langs/elixir"),
  haskell: () => import("@shikijs/langs/haskell"),
  clojure: () => import("@shikijs/langs/clojure"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  erlang: () => import("@shikijs/langs/erlang"),
  zig: () => import("@shikijs/langs/zig"),
  nim: () => import("@shikijs/langs/nim"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  xml: () => import("@shikijs/langs/xml"),
  svg: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  bash: () => import("@shikijs/langs/bash"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  fish: () => import("@shikijs/langs/fish"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  prisma: () => import("@shikijs/langs/prisma"),
  docker: () => import("@shikijs/langs/docker"),
  hcl: () => import("@shikijs/langs/hcl"),
  nix: () => import("@shikijs/langs/nix"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  tex: () => import("@shikijs/langs/tex"),
  diff: () => import("@shikijs/langs/diff"),
  regex: () => import("@shikijs/langs/regex"),
  viml: () => import("@shikijs/langs/viml"),
  makefile: () => import("@shikijs/langs/makefile"),
  cmake: () => import("@shikijs/langs/cmake"),
  groovy: () => import("@shikijs/langs/groovy"),
};

const languageAliases: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "shellscript",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  vim: "viml",
  objc: "objective-c",
  objectivec: "objective-c",
  "obj-c": "objective-c",
  ps1: "powershell",
  pwsh: "powershell",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  ml: "ocaml",
  fs: "fsharp",
  tf: "hcl",
  make: "makefile",
  plain: "text",
  plaintext: "text",
  txt: "text",
};
let highlighterPromise: Promise<HighlighterCore> | null = null;

type LoadedLanguageModule = {
  default: Parameters<HighlighterCore["loadLanguage"]>[0];
};

function isReviewHighlighterDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewHighlighterDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!isReviewHighlighterDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-highlighter] ${message}`, details);
    return;
  }

  console.log(`[review-highlighter] ${message}`);
}

function logReviewHighlighterDiagnosticError(message: string, error: unknown): void {
  if (!isReviewHighlighterDebugLoggingEnabled()) {
    return;
  }
  console.error(`[review-highlighter] ${message}`, error);
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const configuredHighlighterPromise = (async () => {
      let nativeEngineAvailable = false;
      let nativeInitializationError: ReviewHighlighterEngineInitializationError | undefined;

      logReviewHighlighterDiagnostic("initializing", {
        configuredPreference: REVIEW_HIGHLIGHTER_ENGINE_ENV_VALUE,
        preference: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
      });

      const themes = [githubLightDefault, githubDarkDefault];

      if (REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE !== "javascript") {
        try {
          const nativeEngineModule = await import("react-native-shiki-engine");
          nativeEngineAvailable = nativeEngineModule.isNativeEngineAvailable();
          logReviewHighlighterDiagnostic("checked native engine availability", {
            nativeEngineAvailable,
          });

          if (nativeEngineAvailable) {
            logReviewHighlighterDiagnostic("creating native regex engine");
            const highlighter = await createHighlighterCore({
              themes,
              langs: REVIEW_INITIAL_LANGUAGE_MODULES,
              engine: nativeEngineModule.createNativeEngine(),
            });
            logReviewHighlighterDiagnostic("using native engine");
            return {
              highlighter,
              engine: "native" as const,
            };
          }
        } catch (error) {
          nativeInitializationError = new ReviewHighlighterEngineInitializationError({
            preferredEngine: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
            attemptedEngine: "native",
            cause: error,
          });
          logReviewHighlighterDiagnosticError(
            "native engine initialization failed; falling back to javascript",
            nativeInitializationError,
          );
          nativeEngineAvailable = false;
        }
      } else {
        logReviewHighlighterDiagnostic("skipping native engine probe", {
          reason: "preference-forced-javascript",
        });
      }

      const engine = resolveReviewHighlighterEngine(
        REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
        nativeEngineAvailable,
      );
      let highlighter: HighlighterCore;
      try {
        highlighter = await createHighlighterCore({
          themes,
          langs: REVIEW_INITIAL_LANGUAGE_MODULES,
          engine: createJavaScriptRegexEngine(),
        });
      } catch (cause) {
        const javascriptError = new ReviewHighlighterEngineInitializationError({
          preferredEngine: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
          attemptedEngine: "javascript",
          cause,
        });
        if (!nativeInitializationError) throw javascriptError;
        throw new ReviewHighlighterEngineInitializationError({
          preferredEngine: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
          attemptedEngine: "javascript",
          cause: new AggregateError(
            [nativeInitializationError, javascriptError],
            "Native and JavaScript review highlighter initialization failed.",
            { cause: nativeInitializationError },
          ),
        });
      }
      logReviewHighlighterDiagnostic("using javascript engine", {
        resolvedEngine: engine,
      });
      return {
        highlighter,
        engine,
      };
    })();

    highlighterPromise = configuredHighlighterPromise
      .then((result) => result.highlighter)
      .catch((error) => {
        highlighterPromise = null;
        throw error;
      });
  }

  return highlighterPromise;
}

function resolveLanguageAlias(language: string): string {
  const normalized = language.toLowerCase();
  return languageAliases[normalized] ?? normalized;
}

function resolveLoadedLanguageFromPath(
  path: string,
  languageHint: string | null = null,
): string | null {
  const detectedLanguage = languageHint ?? getFiletypeFromFileName(path);
  if (!detectedLanguage) {
    return "text";
  }

  const candidate = resolveLanguageAlias(detectedLanguage);
  if (candidate === "text" || candidate === "ansi") {
    return "text";
  }

  if (!(candidate in languageImports)) {
    return "text";
  }

  return loadedLanguages.has(candidate) ? candidate : null;
}

async function loadSingleLanguage(
  highlighter: HighlighterCore,
  language: string,
): Promise<boolean> {
  if (loadedLanguages.has(language)) {
    return true;
  }

  const existingPromise = languageLoadingPromises.get(language);
  if (existingPromise) {
    return existingPromise;
  }

  const importer = languageImports[language];
  if (!importer) {
    return false;
  }

  const loadingPromise = (async () => {
    try {
      const languageModule = (await importer()) as LoadedLanguageModule;
      await highlighter.loadLanguage(languageModule.default);
      loadedLanguages.add(language);
      return true;
    } catch {
      return false;
    } finally {
      languageLoadingPromises.delete(language);
    }
  })();

  languageLoadingPromises.set(language, loadingPromise);
  return loadingPromise;
}

async function resolveLanguageFromPath(
  path: string,
  languageHint: string | null = null,
): Promise<string> {
  const loadedLanguage = resolveLoadedLanguageFromPath(path, languageHint);
  if (loadedLanguage) {
    return loadedLanguage;
  }

  const detectedLanguage = languageHint ?? getFiletypeFromFileName(path);
  if (!detectedLanguage) {
    return "text";
  }

  const candidate = resolveLanguageAlias(detectedLanguage);
  if (candidate === "text" || candidate === "ansi") {
    return "text";
  }

  if (!(candidate in languageImports)) {
    return "text";
  }

  if (loadedLanguages.has(candidate)) {
    return candidate;
  }

  const highlighter = await getHighlighter();
  const loaded = await loadSingleLanguage(highlighter, candidate);
  if (!loaded) {
    return "text";
  }

  return candidate;
}

function normalizeHighlightedLines(
  tokenLines: ReadonlyArray<ReadonlyArray<{ content: string; color?: string; fontStyle?: number }>>,
): ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> {
  return tokenLines.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

/** Preserve multiline grammar across scheduling boundaries without replaying
 * previously highlighted text. Oversized lines deliberately bypass tokenizing;
 * reset after that unknown context instead of carrying a potentially closed
 * comment/string into the rest of the file.
 */
function createChunkTokenizer(highlighter: HighlighterCore, language: string, theme: string) {
  let grammarState: GrammarState | undefined;
  return {
    tokenize: (lines: ReadonlyArray<string>) => {
      const tokens = highlighter.codeToTokensBase(lines.join("\n"), {
        lang: language,
        theme,
        ...(grammarState ? { grammarState } : {}),
      });
      grammarState = highlighter.getLastGrammarState(tokens);
      return normalizeHighlightedLines(tokens);
    },
    reset: () => {
      grammarState = undefined;
    },
  };
}

async function highlightLines(
  code: string,
  language: string,
  theme: string,
): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  if (code.length === 0) {
    return [];
  }

  const highlighter = await getHighlighter();
  const tokenizer = createChunkTokenizer(highlighter, language, theme);
  const sourceLines = code.split("\n");
  const highlightedLines: Array<ReadonlyArray<ReviewHighlightedToken>> = [];
  const shortLineBatch: string[] = [];
  let chunkSize = 16;

  const flushShortLineBatch = async (): Promise<void> => {
    if (shortLineBatch.length === 0) {
      return;
    }

    const started = performance.now();
    highlightedLines.push(...tokenizer.tokenize(shortLineBatch));
    chunkSize = nextHighlightChunkSize(shortLineBatch.length, performance.now() - started);
    shortLineBatch.length = 0;
  };

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex] ?? "";

    if (line.length > REVIEW_TOKENIZE_MAX_LINE_LENGTH) {
      await flushShortLineBatch();
      highlightedLines.push([{ content: line, color: null, fontStyle: null }]);
      tokenizer.reset();
    } else {
      shortLineBatch.push(line);
    }

    if (shortLineBatch.length >= chunkSize) {
      await flushShortLineBatch();
    }

    if (
      sourceLines.length > REVIEW_HIGHLIGHT_CHUNK_LINE_THRESHOLD &&
      lineIndex + 1 < sourceLines.length &&
      (shortLineBatch.length === 0 || line.length > REVIEW_TOKENIZE_MAX_LINE_LENGTH)
    ) {
      await waitForNextFrame();
    }
  }

  await flushShortLineBatch();

  return highlightedLines;
}

export async function highlightCodeSnippet(input: {
  readonly code: string;
  readonly language?: string | null;
  readonly theme: ReviewDiffTheme;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  const languageHint = input.language?.trim() || "text";
  const language = await resolveLanguageFromPath(`snippet.${languageHint}`, languageHint);
  return highlightLines(input.code, language, SHIKI_THEME_NAME_BY_SCHEME[input.theme]);
}

export async function highlightSourceFile(input: {
  readonly path: string;
  readonly contents: string;
  readonly theme: ReviewDiffTheme;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  const language = await resolveLanguageFromPath(input.path);
  return highlightLines(input.contents, language, SHIKI_THEME_NAME_BY_SCHEME[input.theme]);
}
