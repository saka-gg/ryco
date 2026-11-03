// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "vite-plus";
import { describe, expect, it, vi } from "vite-plus/test";

import type { FatalErrorStore } from "./fatalErrorRecorder";

const stored = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("./fatalErrorStore", () => ({
  fatalErrorFileStore: (): FatalErrorStore => ({
    read: () => stored.text,
    write: (text) => {
      stored.text = text;
    },
    clear: () => {
      stored.text = null;
    },
  }),
}));

import { parseFatalErrorRecords } from "./fatalErrorRecorder";
import { FatalRenderErrorBoundary } from "./FatalRenderErrorBoundary";

/** The name of the element `App.tsx`'s default export renders at its root. */
function appRootElement(): string | undefined {
  const file = join(import.meta.dirname, "../App.tsx");
  const { program } = parseSync(file, readFileSync(file, "utf8"));
  const exported = program.body.find((node) => node.type === "ExportDefaultDeclaration");
  if (exported?.type !== "ExportDefaultDeclaration") return undefined;
  const { declaration } = exported;
  if (declaration.type !== "FunctionDeclaration" || !declaration.body) return undefined;
  const returned = declaration.body.body.find((node) => node.type === "ReturnStatement");
  if (returned?.type !== "ReturnStatement") return undefined;
  let element = returned.argument;
  while (element?.type === "ParenthesizedExpression") element = element.expression;
  if (element?.type !== "JSXElement") return undefined;
  const { name } = element.openingElement;
  return name.type === "JSXIdentifier" ? name.name : undefined;
}

describe("fatal render error boundary", () => {
  it("wraps the whole app, the app's own hooks included", () => {
    expect(appRootElement()).toBe("FatalRenderErrorBoundary");
  });

  it("records the crash, then throws the same error on so React still reports it as fatal", () => {
    const boundary = new FatalRenderErrorBoundary({ children: null });
    const error = new TypeError("cannot read property 'id' of undefined");
    let thrown: unknown;
    try {
      boundary.componentDidCatch(error);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
    expect(parseFatalErrorRecords(stored.text, Date.now())).toEqual([
      expect.objectContaining({ message: "TypeError: cannot read property 'id' of undefined" }),
    ]);
  });
});
