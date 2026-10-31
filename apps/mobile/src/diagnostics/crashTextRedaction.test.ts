import { describe, expect, it } from "vite-plus/test";

import { redactCrashText } from "./crashTextRedaction";

// Built from parts, so no fixture looks like a real credential.
const TOKEN = ["not", "a", "real", "token"].join("-");

describe("crash text redaction", () => {
  it("keeps only the last part of absolute paths on every platform", () => {
    expect(
      redactCrashText("ENOENT: open '/var/mobile/Containers/Data/Application/X/Documents/a.json'"),
    ).toBe("ENOENT: open 'a.json'");
    expect(redactCrashText("at f (file:///private/var/app/main.jsbundle:3:4)")).toBe(
      "at f (main.jsbundle:3:4)",
    );
    expect(redactCrashText("renderThread@/var/app/Ryco.app/main.jsbundle:1:2")).toBe(
      "renderThread@main.jsbundle:1:2",
    );
    expect(redactCrashText("open C:\\Users\\Laurin\\Code\\x.ts failed")).toBe("open x.ts failed");
    expect(redactCrashText("at g (C:\\a\\b.js:1:2)")).toBe("at g (b.js:1:2)");
    expect(redactCrashText("file:///C:/Users/Laurin/a.js")).toBe("a.js");
    expect(redactCrashText("read \\\\server\\share\\Laurin\\x.ts")).toBe("read x.ts");
    expect(redactCrashText("~/Code/ryco/x.ts")).toBe("x.ts");
  });

  it("removes folders whose names hold spaces, and keeps a file name's spaces", () => {
    expect(redactCrashText("/Users/Laurin Frank/Code/x.ts")).toBe("x.ts");
    expect(redactCrashText("C:\\Users\\Laurin Frank\\Code\\x.ts")).toBe("x.ts");
    expect(redactCrashText("open '/Users/Laurin Frank/My File.ts' failed")).toBe(
      "open 'My File.ts' failed",
    );
    // A space before a slash ends the path: two paths, not one folder named "b to ".
    expect(redactCrashText("copy /a/b to /c/d")).toBe("copy b to d");
    expect(redactCrashText("path=/a/b/c, other=/d/e/f;")).toBe("path=c, other=f;");
  });

  it("drops URL user info, query strings and fragments, keeping a frame's position", () => {
    expect(redactCrashText(`WebSocket wss://node.example/ws?wsToken=${TOKEN} failed`)).toBe(
      "WebSocket wss://node.example/ws failed",
    );
    expect(
      redactCrashText(`POST https://user:${TOKEN}@node.example:3773/api/upload?token=${TOKEN}#x`),
    ).toBe("POST https://node.example:3773/api/upload");
    expect(
      redactCrashText("at f (http://192.168.1.5:8081/index.bundle?platform=ios&dev=true:12:34)"),
    ).toBe("at f (http://192.168.1.5:8081/index.bundle:12:34)");
    // A query on a path or name without a scheme goes too.
    expect(redactCrashText(`GET /ws?wsToken=${TOKEN} 401`)).toBe("GET /ws 401");
    expect(redactCrashText(`upload?token=${TOKEN}:1:2 failed`)).toBe("upload:1:2 failed");
  });

  it("leaves text that is not a path alone", () => {
    for (const text of [
      "Cannot find module 'foo/bar'",
      "expected a/b/c, 1 / 2 and 2026/10/31",
      "café/x/y",
      "what? x=1",
      "TypeError: undefined is not an object (evaluating 'a.b')",
    ]) {
      expect(redactCrashText(text)).toBe(text);
    }
  });

  it("changes nothing the second time", () => {
    for (const text of [
      `wss://node.example/ws?wsToken=${TOKEN}`,
      "at f (file:///private/var/app/main.jsbundle:3:4)",
      "/Users/Laurin Frank/Code/x.ts and C:\\Users\\Laurin\\y.ts",
      "at f (http://192.168.1.5:8081/index.bundle//&platform=ios:12:34)",
    ]) {
      const once = redactCrashText(text);
      expect(redactCrashText(once)).toBe(once);
    }
  });
});
