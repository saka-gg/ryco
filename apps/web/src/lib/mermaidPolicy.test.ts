import { describe, expect, it } from "vitest";
import {
  isClosedMermaidFence,
  isMermaidLanguage,
  isSupportedMermaidSource,
  MERMAID_LIMITS,
} from "./mermaidPolicy";

describe("Mermaid source boundary", () => {
  it("recognizes only the two fence languages", () => {
    for (const language of ["mermaid", "mmd", "MERMAID"])
      expect(isMermaidLanguage(language)).toBe(true);
    for (const language of ["js", "mermaid-script", ""])
      expect(isMermaidLanguage(language)).toBe(false);
  });
  it.each([
    "flowchart TD\nA[Start] --> B{Ready?}\nB --> C[Done]",
    "graph LR; A --> B",
    "%% heading\nsequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hi",
  ])("accepts supported source: %s", (source) => {
    expect(isSupportedMermaidSource(source)).toBe(true);
  });
  it.each([
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA-->B',
    'flowchart TD\n%% {initialize: {"themeCSS":"body{display:none}"}} %%\nA-->B',
    "---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\nA-->B",
    "flowchart TD\n---\nconfig:",
    "flowchart TD\nA[<img src=x onerror=alert(1)>]",
    "flowchart TD\nA[&#60;script&#62;]",
    'flowchart TD\nA-->B\nclick A "javascript:alert(1)"',
    'flowchart TD\nA@{ img: "https://invalid.test/x" }',
    "flowchart TD\nclassDef red fill:url(https://invalid.test)",
    "flowchart TD\nstyle A fill:red",
    'sequenceDiagram\nlinks Alice: {"Page": "https://invalid.test"}',
    "flowchart TD\nA & B --> C & D",
    'flowchart TD\nA["$$x$$"]',
    'flowchart TD\nA["\\u003cscript"]',
    "gantt\ndateFormat YYYY-MM-DD",
    "xychart-beta\nx-axis [1,2]",
    "architecture-beta\nservice a(server)",
  ])("rejects unsupported or active content: %s", (source) => {
    expect(isSupportedMermaidSource(source)).toBe(false);
  });
  it("bounds source, lines and lexical complexity before importing Mermaid", () => {
    expect(
      isSupportedMermaidSource(`flowchart TD\nA[${"x".repeat(MERMAID_LIMITS.sourceCharacters)}]`),
    ).toBe(false);
    expect(isSupportedMermaidSource(`flowchart TD\n${"A-->B\n".repeat(201)}`)).toBe(false);
    expect(isSupportedMermaidSource(`flowchart TD\n${"A ".repeat(401)}`)).toBe(false);
    expect(isSupportedMermaidSource(`flowchart TD\nA[${"x".repeat(1001)}]`)).toBe(false);
  });
});

it("requires a matching closing fence", () => {
  for (const text of ["```mermaid\nflowchart TD\nA-->B\n```", "~~~~mmd\nsequenceDiagram\n~~~~~"]) {
    expect(isClosedMermaidFence(text, 0, text.length)).toBe(true);
  }
  for (const text of [
    "```mermaid\nflowchart TD\nA-->B",
    "~~~~mermaid\nflowchart TD\n~~~",
    "```mermaid\nflowchart TD\n~~~",
  ]) {
    expect(isClosedMermaidFence(text, 0, text.length)).toBe(false);
  }
});
