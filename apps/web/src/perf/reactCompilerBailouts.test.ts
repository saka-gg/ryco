import { describe, expect, it } from "vite-plus/test";

import { analyzeReactCompilerModule } from "./reactCompilerBailouts";

const FILE = "/repo/apps/web/src/components/Fixture.tsx";

const WRITER = `
export function Writer({ value }: { readonly value: number }) {
  const latest = useRef(0);
  latest.current = value;
  return <p>{value}</p>;
}
`;

const CLEAN = `
export function Clean({ label }: { readonly label: string }) {
  const [count] = useState(0);
  return <span>{label}{count}</span>;
}
`;

const module = (...parts: string[]) =>
  [`import { memo, useRef, useState } from "react";`, ...parts].join("\n");

function summarize(report: Awaited<ReturnType<typeof analyzeReactCompilerModule>>) {
  return {
    bailouts: report.bailouts.map(({ fn, reasons }) => ({ fn, reasons })),
    optedOut: report.optedOut,
    compiled: report.compiled,
  };
}

describe("analyzeReactCompilerModule", () => {
  it("reports a component that writes a ref during render as a bailout", async () => {
    const report = await analyzeReactCompilerModule(FILE, module(WRITER));

    expect(summarize(report)).toEqual({
      bailouts: [{ fn: "Writer", reasons: ["Cannot access refs during render"] }],
      optedOut: [],
      compiled: [],
    });
    expect(report.bailouts[0]?.codeframes.join("\n")).toContain("latest.current = value");
  });

  it('reports a function that opts out with "use no memo" as opted out, not as a bailout', async () => {
    const optedOut = WRITER.replace("{\n  const latest", '{\n  "use no memo";\n  const latest');
    const report = await analyzeReactCompilerModule(FILE, module(optedOut, CLEAN));

    expect(summarize(report)).toEqual({ bailouts: [], optedOut: ["Writer"], compiled: ["Clean"] });
  });

  it('treats a module-level "use no memo" as opting out every function', async () => {
    const report = await analyzeReactCompilerModule(FILE, `"use no memo";\n${module(WRITER)}`);

    expect(summarize(report)).toEqual({ bailouts: [], optedOut: ["<module>"], compiled: [] });
  });

  it("attributes diagnostics after non-ASCII text to the right function", async () => {
    // Oxc reports UTF-8 byte offsets: read as UTF-16 offsets, these 200
    // three-byte dashes would move the diagnostic 400 code units past Writer.
    const report = await analyzeReactCompilerModule(
      FILE,
      module(`// Größe “${"—".repeat(200)}”`, WRITER, CLEAN, CLEAN.replaceAll("Clean", "Other")),
    );

    expect(summarize(report)).toEqual({
      bailouts: [{ fn: "Writer", reasons: ["Cannot access refs during render"] }],
      optedOut: [],
      compiled: ["Clean", "Other"],
    });
  });

  it("names memo-wrapped and arrow functions after their binding", async () => {
    const report = await analyzeReactCompilerModule(
      FILE,
      module(
        `export const Row = memo(function Row({ value }: { readonly value: number }) {
  const latest = useRef(0);
  latest.current = value;
  return <li>{value}</li>;
});`,
        `export const useLatest = (value: number) => {
  const latest = useRef(0);
  latest.current = value;
  return latest.current;
};`,
      ),
    );

    expect(report.bailouts.map(({ fn }) => fn)).toEqual(["Row", "useLatest"]);
  });

  it("names functions without a binding independently of where they sit", async () => {
    const unbound = (body: string) =>
      `memo(({ value }: { readonly value: number }) => {\n${body}\n  return <p>{value}</p>;\n})`;
    const writes = "  const latest = useRef(0);\n  latest.current = value;";
    const source = module(
      "declare function register(component: unknown): void;",
      `register(${unbound(writes)});`,
      `export default ${unbound(writes)};`,
    );

    for (const code of [source, source.replace("declare", "// moved down a line\ndeclare")]) {
      const report = await analyzeReactCompilerModule(FILE, code);
      expect(report.bailouts.map(({ fn }) => fn)).toEqual(["<anonymous>", "default"]);
    }
  });

  it("reports compiled functions, including ones that need no memo cache", async () => {
    const report = await analyzeReactCompilerModule(
      FILE,
      module(
        CLEAN,
        `export function useFirst(value: number) {
  const [first] = useState(value);
  return first;
}`,
        "export function formatCount(count: number) {\n  return `${count}`;\n}",
      ),
    );

    expect(summarize(report)).toEqual({
      bailouts: [],
      optedOut: [],
      compiled: ["Clean", "useFirst"],
    });
  });
});
