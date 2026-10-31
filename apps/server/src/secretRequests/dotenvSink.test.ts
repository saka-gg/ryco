import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DotenvSinkError,
  encodeDotenvValue,
  normalizeDotenvRelativePath,
  resolveDotenvTarget,
  upsertDotenvAssignment,
  writeDotenvSecret,
} from "./dotenvSink.ts";

// Built from parts, so no fixture looks like a real credential.
const SECRET = ["ryco", "test", "value", "7f3a"].join("-");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Ryco Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, stdio: "pipe" },
  );

/** A Git checkout that ignores `.env`, `.env.local` and `apps/*.env`, plus a folder outside it. */
function checkout(): { root: string; outside: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ryco-dotenv-sink-"));
  roots.push(base);
  const root = path.join(base, "checkout");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  git(root, "init", "-q");
  writeFileSync(path.join(root, ".gitignore"), ".env\n.env.local\napps/*.env\n");
  // Tracked first, then matched by the ignore file: Git still tracks it.
  mkdirSync(path.join(root, "config"));
  writeFileSync(path.join(root, "config", "app.env"), "A=1\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  writeFileSync(path.join(root, ".gitignore"), ".env\n.env.local\napps/*.env\n*.env\n");
  return { root, outside };
}

const reason = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof DotenvSinkError) return cause.reason;
    throw cause;
  }
  return "ok";
};

describe("dotenv sink paths", () => {
  it("accepts plain relative dotenv paths and refuses everything else before touching disk", () => {
    expect(normalizeDotenvRelativePath(".env")).toBe(".env");
    expect(normalizeDotenvRelativePath("apps/web/.env.local")).toBe("apps/web/.env.local");
    expect(normalizeDotenvRelativePath("config/stripe.env")).toBe("config/stripe.env");
    expect(normalizeDotenvRelativePath(".dev.vars")).toBe(".dev.vars");
    for (const file of [
      "/etc/.env",
      "../.env",
      "apps/../.env",
      "./.env",
      ".git/.env",
      ".GIT/.env",
      "apps/.Git/x.env",
      "apps\\.env",
      "apps//.env",
      ".env\n",
      "src/index.js",
      ".envrc",
      ".gitconfig",
      "*.env",
      ":(top).env",
      "",
    ]) {
      expect(normalizeDotenvRelativePath(file), file).toBeNull();
    }
  });

  it("refuses a link anywhere on the way, so a write cannot leave the checkout", async () => {
    const { root, outside } = checkout();
    writeFileSync(path.join(outside, "target.env"), "UNTOUCHED=1\n");
    symlinkSync(path.join(outside, "target.env"), path.join(root, ".env"));
    symlinkSync(outside, path.join(root, "apps"));
    for (const file of [".env", "apps/target.env"]) {
      expect(
        await reason(writeDotenvSecret({ checkout: root, file, key: "KEY", value: SECRET })),
        file,
      ).toBe("unsafe-path");
    }
    expect(readFileSync(path.join(outside, "target.env"), "utf8")).toBe("UNTOUCHED=1\n");
    expect(readdirSync(outside)).toEqual(["target.env"]);
  });

  it("refuses a file Git tracks or does not ignore, and a folder that is not a repository", async () => {
    const { root, outside } = checkout();
    // Matched by `*.env` now, but tracked: a commit would pick it up.
    expect(await reason(resolveDotenvTarget({ checkout: root, file: "config/app.env" }))).toBe(
      "not-ignored",
    );
    expect(await reason(resolveDotenvTarget({ checkout: root, file: ".env.production" }))).toBe(
      "not-ignored",
    );
    expect(await reason(resolveDotenvTarget({ checkout: outside, file: ".env" }))).toBe("not-git");
    expect(await reason(resolveDotenvTarget({ checkout: root, file: "missing/.env" }))).toBe(
      "unsafe-path",
    );
    expect(
      await reason(resolveDotenvTarget({ checkout: path.join(root, "nope"), file: ".env" })),
    ).toBe("no-checkout");
    mkdirSync(path.join(root, ".env.local"));
    expect(await reason(resolveDotenvTarget({ checkout: root, file: ".env.local" }))).toBe(
      "not-regular-file",
    );
    expect(readFileSync(path.join(root, "config", "app.env"), "utf8")).toBe("A=1\n");
  });
});

describe("dotenv sink writes", () => {
  it("creates the file with mode 0600 and a value every loader reads back literally", async () => {
    const { root } = checkout();
    const value = `${SECRET}$HOME#not-a-comment "quoted" back\\slash`;
    await writeDotenvSecret({ checkout: root, file: ".env", key: "API_KEY", value });
    const file = path.join(root, ".env");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(parseEnv(readFileSync(file, "utf8"))).toEqual({ API_KEY: value });
    // Nothing else is left next to it, and Git still ignores it.
    expect(readdirSync(root).toSorted()).toEqual([".env", ".git", ".gitignore", "config"]);
    expect(git(root, "status", "--porcelain", "--", ".env").toString()).toBe("");
  });

  it("updates the key in place, keeps every other line, and replaces the file atomically", async () => {
    const { root } = checkout();
    const file = path.join(root, ".env");
    writeFileSync(
      file,
      [
        "# keep this comment",
        "FIRST=1",
        "export API_KEY='old'",
        "MIDDLE=two",
        'API_KEY="multi',
        'line"',
        "LAST=3",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    const before = statSync(file).ino;
    await writeDotenvSecret({ checkout: root, file: ".env", key: "API_KEY", value: SECRET });
    const content = readFileSync(file, "utf8");
    expect(content).toBe(
      [
        "# keep this comment",
        "FIRST=1",
        `export API_KEY='${SECRET}'`,
        "MIDDLE=two",
        "LAST=3",
        "",
      ].join("\n"),
    );
    expect(parseEnv(content)).toEqual({ FIRST: "1", API_KEY: SECRET, MIDDLE: "two", LAST: "3" });
    // Renamed into place (a new inode), never rewritten through the old one, and tightened to 0600.
    expect(statSync(file).ino).not.toBe(before);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("removes a temporary file a crashed write left behind", async () => {
    const { root } = checkout();
    // The writer's temporary name: a dot, the file's name, `.ryco-<uuid>.tmp`.
    const leftover = path.join(
      root,
      `..env.local.ryco-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.tmp`,
    );
    writeFileSync(leftover, "API_KEY='stale'\n");
    await writeDotenvSecret({ checkout: root, file: ".env.local", key: "API_KEY", value: SECRET });
    expect(readdirSync(root).filter((name) => name.includes("ryco-"))).toEqual([]);
  });

  it("writes into an ignored file below the checkout", async () => {
    const { root } = checkout();
    mkdirSync(path.join(root, "apps"));
    await writeDotenvSecret({ checkout: root, file: "apps/web.env", key: "TOKEN", value: SECRET });
    expect(parseEnv(readFileSync(path.join(root, "apps", "web.env"), "utf8"))).toEqual({
      TOKEN: SECRET,
    });
  });
});

describe("dotenv value encoding", () => {
  const roundTrip = (value: string) => {
    const encoded = encodeDotenvValue(value);
    if (!("encoded" in encoded)) throw new Error(encoded.reason);
    return parseEnv(upsertDotenvAssignment("", "KEY", encoded.encoded)).KEY;
  };

  it("quotes so the value reads back unchanged, multi-line keys included", () => {
    for (const value of [
      SECRET,
      "it's",
      "a b\tc",
      "line one\nline two",
      `-----BEGIN KEY-----\nAbC+/=\n-----END KEY-----`,
    ]) {
      expect(roundTrip(value), value).toBe(value);
    }
  });

  it("refuses what a dotenv file cannot hold safely, without naming the value", () => {
    expect(encodeDotenvValue("")).toEqual({ reason: "empty-value" });
    expect(encodeDotenvValue("x".repeat(16 * 1024 + 1))).toEqual({ reason: "value-too-long" });
    expect(encodeDotenvValue("a\rb")).toEqual({ reason: "value-characters" });
    expect(encodeDotenvValue("a\u0000b")).toEqual({ reason: "value-characters" });
    expect(encodeDotenvValue(`it's "both"`)).toEqual({ reason: "value-quoting" });
    expect(encodeDotenvValue("line\n$HOME")).toEqual({ reason: "value-quoting" });
    expect(encodeDotenvValue("it's\\n")).toEqual({ reason: "value-quoting" });
  });
});
