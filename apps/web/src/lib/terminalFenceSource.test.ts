import { describe, expect, it } from "vite-plus/test";
import { terminalFenceSource } from "./terminalFenceSource";

describe("terminal fence source", () => {
  it("removes only the synthetic renderer newline and preserves Unicode and empty lines", () => {
    const text = "```bash\nprintf 'héllo 🌏'\n\n```";
    expect(terminalFenceSource(text, 0, text.length, "printf 'héllo 🌏'\n\n")).toBe(
      "printf 'héllo 🌏'\n",
    );
  });
  it("retains original CRLF bytes from the AST source span", () => {
    const text = "```sh\r\nprintf 'a'\r\nprintf 'b'\r\n```";
    expect(terminalFenceSource(text, 0, text.length, "printf 'a'\nprintf 'b'\n")).toBe(
      "printf 'a'\r\nprintf 'b'",
    );
  });
  it("uses parsed logical indentation and rejects unclosed or missing AST spans", () => {
    const text = "  ```zsh\n  printf 'a'\n  ```";
    expect(terminalFenceSource(text, 0, text.length, "printf 'a'\n")).toBe("printf 'a'");
    expect(terminalFenceSource("```sh\nprintf a", 0, 14, "printf a\n")).toBeUndefined();
    expect(terminalFenceSource(text, undefined, undefined, "printf a\n")).toBeUndefined();
    const quoted = "> ```sh\n> printf 'a'\n> ```";
    expect(terminalFenceSource(quoted, 2, quoted.length, "printf 'a'\n")).toBe("printf 'a'");
  });
});
