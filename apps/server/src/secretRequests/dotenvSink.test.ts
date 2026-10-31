import { execFileSync } from "node:child_process";
import {
  constants as FsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  checkoutIdentity,
  DotenvSinkError,
  encodeDotenvValue,
  LEFTOVER_TEMPORARY_MIN_AGE_MS,
  normalizeDotenvRelativePath,
  removeDotenvSecretLeftovers,
  resolveDotenvTarget,
  upsertDotenvAssignment,
  writeDotenvSecret,
} from "./dotenvSink.ts";

// Built from parts, so no fixture looks like a real credential.
const SECRET = ["ryco", "test", "value", "7f3a"].join("-");

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

/** A write for the checkout's own identity, as an answer to a request opened there. */
const write = (root: string, file: string, key: string, value: string) =>
  writeDotenvSecret({
    checkout: root,
    file,
    key,
    value,
    checkoutId: checkoutIdentity(realpathSync(root)),
  });

/** A temporary file's name as the writer makes it, with a fixed id. */
const uuid = `${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`;
const age = (file: string, ms: number) => {
  const then = new Date(Date.now() - ms);
  utimesSync(file, then, then);
};

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
    expect(normalizeDotenvRelativePath(".env.production.local")).toBe(".env.production.local");
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
      // Code and config files that only look like dotenv files.
      ".env.js",
      ".env.json",
      ".env.py",
      ".env.sh",
      ".env.ts",
      ".env.local.mjs",
      "app.env.yaml",
      // Windows drops trailing dots (`.git.` is `.git`) and opens device names.
      ".git./x.env",
      ".env.",
      "...",
      "a/.../.env",
      "con.env",
      "nul/.env",
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
      expect(await reason(write(root, file, "KEY", SECRET)), file).toBe("unsafe-path");
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

  it("refuses a name Git tracks in another letter case, deleted or not", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ryco-dotenv-case-"));
    roots.push(base);
    const root = path.join(base, "checkout");
    mkdirSync(path.join(root, "Cfg"), { recursive: true });
    git(root, "init", "-q");
    writeFileSync(path.join(root, "Prod.env"), "A=1\n");
    writeFileSync(path.join(root, "Old.env"), "B=1\n");
    writeFileSync(path.join(root, "Cfg", ".env"), "C=1\n");
    git(root, "add", "-f", ".");
    git(root, "commit", "-q", "-m", "tracked");
    writeFileSync(path.join(root, ".gitignore"), "*.env\n.env*\n");
    unlinkSync(path.join(root, "Old.env"));
    // Where the file system folds case (macOS), `prod.env` opens the tracked `Prod.env`; where
    // it does not, it is a new file Git would still match to the index entry on such a system.
    expect(["name-case", "tracked"]).toContain(await reason(write(root, "prod.env", "K", SECRET)));
    expect(await reason(write(root, "old.env", "K", SECRET))).toBe("tracked");
    expect(await reason(write(root, "Prod.env", "K", SECRET))).toBe("not-ignored");
    expect(await reason(write(root, "cfg/.env", "K", SECRET))).toBe("unsafe-path");
    expect(readFileSync(path.join(root, "Prod.env"), "utf8")).toBe("A=1\n");
    expect(readFileSync(path.join(root, "Cfg", ".env"), "utf8")).toBe("C=1\n");
    // Nothing a commit would pick up: only the deleted file and the new ignore file show.
    expect(git(root, "status", "--porcelain").toString().split("\n").toSorted()).toEqual(
      ["", " D Old.env", "?? .gitignore"].toSorted(),
    );
  });

  it("refuses a file of a repository nested in the checkout, which its own index may track", async () => {
    const { root } = checkout();
    writeFileSync(path.join(root, ".gitignore"), "vendor/\n.env\napps/*.env\n");
    const nested = path.join(root, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    writeFileSync(path.join(nested, ".env"), "API_KEY=placeholder\n");
    git(nested, "add", "-f", ".env");
    git(nested, "commit", "-q", "-m", "tracked");
    expect(await reason(write(root, "vendor/lib/.env", "API_KEY", SECRET))).toBe(
      "other-repository",
    );
    expect(readFileSync(path.join(nested, ".env"), "utf8")).toBe("API_KEY=placeholder\n");
    expect(git(nested, "status", "--porcelain").toString()).toBe("");
    // A plain ignored folder of the checkout's own repository is fine.
    mkdirSync(path.join(root, "vendor", "plain"));
    await write(root, "vendor/plain/.env", "API_KEY", SECRET);
    // So is a checkout that is a folder of a larger repository.
    mkdirSync(path.join(root, "apps"));
    await write(path.join(root, "apps"), "web.env", "TOKEN", SECRET);
    expect(parseEnv(readFileSync(path.join(root, "apps", "web.env"), "utf8"))).toEqual({
      TOKEN: SECRET,
    });
  });

  it("writes only into the checkout the request was opened for", async () => {
    const { root } = checkout();
    const other = checkoutIdentity(realpathSync(path.join(root, "config")));
    expect(
      await reason(
        writeDotenvSecret({
          checkout: root,
          file: ".env",
          key: "KEY",
          value: SECRET,
          checkoutId: other,
        }),
      ),
    ).toBe("checkout-changed");
    expect(existsSync(path.join(root, ".env"))).toBe(false);
    expect((await resolveDotenvTarget({ checkout: root, file: ".env" })).checkoutId).toBe(
      checkoutIdentity(realpathSync(root)),
    );
    expect(checkoutIdentity(realpathSync(root))).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe("dotenv sink writes", () => {
  it("creates the file with mode 0600 and a value every loader reads back literally", async () => {
    const { root } = checkout();
    const value = `${SECRET}#not-a-comment "quoted" a=b`;
    await write(root, ".env", "API_KEY", value);
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
    await write(root, ".env", "API_KEY", SECRET);
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

  it("keeps the temporary file in Git's own directory, never where `git add -A` sees it", async () => {
    const { root } = checkout();
    const created: string[] = [];
    const synced: string[] = [];
    const open = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, "open").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.open>
    ) => {
      const [file, flags] = args;
      if (typeof flags === "number" && (flags & FsConstants.O_CREAT) !== 0) {
        created.push(String(file));
      }
      const handle = await open(...args);
      if (flags === FsConstants.O_RDONLY && statSync(String(file)).isDirectory()) {
        const sync = handle.sync.bind(handle);
        handle.sync = () => {
          synced.push(String(file));
          return sync();
        };
      }
      return handle;
    }) as typeof fsPromises.open);
    await write(root, ".env.local", "API_KEY", SECRET);
    const gitDirectory = realpathSync(path.join(root, ".git"));
    expect(created).toHaveLength(1);
    expect(path.dirname(created[0]!)).toBe(gitDirectory);
    expect(path.basename(created[0]!)).toMatch(/^ryco-secret-[0-9a-f-]{36}\.tmp$/u);
    // The rename is made durable, and nothing is left in either place.
    expect(synced).toEqual([realpathSync(root)]);
    expect(readdirSync(gitDirectory).filter((name) => name.startsWith("ryco-"))).toEqual([]);
    expect(readdirSync(root).toSorted()).toEqual([".env.local", ".git", ".gitignore", "config"]);
  });

  it("keeps a linked worktree's temporary file in that worktree's Git directory", async () => {
    const { root } = checkout();
    const worktree = path.join(path.dirname(root), "worktree");
    git(root, "worktree", "add", "-q", "--detach", worktree);
    const created: string[] = [];
    const open = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, "open").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.open>
    ) => {
      if (typeof args[1] === "number" && (args[1] & FsConstants.O_CREAT) !== 0) {
        created.push(String(args[0]));
      }
      return open(...args);
    }) as typeof fsPromises.open);
    writeFileSync(path.join(worktree, ".gitignore"), ".env\n");
    await write(worktree, ".env", "API_KEY", SECRET);
    expect(path.dirname(created[0]!)).toBe(
      realpathSync(path.join(root, ".git", "worktrees", "worktree")),
    );
    expect(parseEnv(readFileSync(path.join(worktree, ".env"), "utf8"))).toEqual({
      API_KEY: SECRET,
    });
  });

  it("falls back to a name Git ignores beside the file when Git's directory is on another file system", async () => {
    const { root } = checkout();
    writeFileSync(path.join(root, ".gitignore"), ".env*\n");
    const rename = fsPromises.rename.bind(fsPromises);
    const renamed: string[] = [];
    vi.spyOn(fsPromises, "rename").mockImplementation((async (from, to) => {
      renamed.push(String(from));
      if (String(from).includes(`${path.sep}.git${path.sep}`)) {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      }
      return rename(from, to);
    }) as typeof fsPromises.rename);
    await write(root, ".env.local", "API_KEY", SECRET);
    expect(renamed).toHaveLength(2);
    expect(path.basename(renamed[1]!)).toMatch(/^\.env\.local\.ryco-[0-9a-f-]{36}\.tmp$/u);
    expect(git(root, "check-ignore", "-q", "--", path.basename(renamed[1]!)).toString()).toBe("");
    expect(parseEnv(readFileSync(path.join(root, ".env.local"), "utf8"))).toEqual({
      API_KEY: SECRET,
    });
    expect(readdirSync(root).filter((name) => name.includes("ryco-"))).toEqual([]);
    expect(readdirSync(path.join(root, ".git")).filter((name) => name.includes("ryco-"))).toEqual(
      [],
    );

    // No ignored name beside the file: refused rather than left where Git would see it.
    writeFileSync(path.join(root, ".gitignore"), ".env\n");
    expect(await reason(write(root, ".env", "API_KEY", SECRET))).toBe("write-failed");
    expect(existsSync(path.join(root, ".env"))).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes("ryco-"))).toEqual([]);
  });

  it("removes old temporary files a crashed write left behind, never a fresh one", async () => {
    const { root } = checkout();
    const gitDirectory = path.join(root, ".git");
    const oldInGit = path.join(gitDirectory, `ryco-secret-${uuid}.tmp`);
    const oldBeside = path.join(root, `..env.local.ryco-${uuid}.tmp`);
    const freshBeside = path.join(root, `.env.local.ryco-${uuid.replace(/^0/u, "1")}.tmp`);
    for (const file of [oldInGit, oldBeside, freshBeside]) writeFileSync(file, "API_KEY='stale'\n");
    for (const file of [oldInGit, oldBeside]) age(file, LEFTOVER_TEMPORARY_MIN_AGE_MS + 1_000);
    await write(root, ".env.local", "API_KEY", SECRET);
    // A fresh one may be another writer's in progress (another node on this checkout).
    expect(readdirSync(root).filter((name) => name.includes("ryco-"))).toEqual([
      path.basename(freshBeside),
    ]);
    expect(readdirSync(gitDirectory).filter((name) => name.startsWith("ryco-"))).toEqual([]);

    // Startup's sweep, by the same rule.
    age(freshBeside, LEFTOVER_TEMPORARY_MIN_AGE_MS + 1_000);
    writeFileSync(oldInGit, "API_KEY='stale'\n");
    age(oldInGit, LEFTOVER_TEMPORARY_MIN_AGE_MS + 1_000);
    await removeDotenvSecretLeftovers({ checkout: root, file: ".env.local" });
    expect(readdirSync(root).filter((name) => name.includes("ryco-"))).toEqual([]);
    expect(readdirSync(gitDirectory).filter((name) => name.startsWith("ryco-"))).toEqual([]);
  });

  it("writes one answer at a time into a file, so parallel answers keep every key", async () => {
    const { root } = checkout();
    const keys = ["FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH"];
    await Promise.all(keys.map((key) => write(root, ".env", key, `${SECRET}-${key}`)));
    expect(parseEnv(readFileSync(path.join(root, ".env"), "utf8"))).toEqual(
      Object.fromEntries(keys.map((key) => [key, `${SECRET}-${key}`])),
    );
  });

  it("writes into an ignored file below the checkout", async () => {
    const { root } = checkout();
    mkdirSync(path.join(root, "apps"));
    await write(root, "apps/web.env", "TOKEN", SECRET);
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
    expect(encodeDotenvValue("line\n`tick`")).toEqual({ reason: "value-quoting" });
  });

  it("refuses $ and backslashes, which dotenv-expand and python-dotenv change even in single quotes", () => {
    for (const value of ["pa$word", "x${HOME}y", "$1", "back\\slash", "tail\\", "line\n$HOME"]) {
      expect(encodeDotenvValue(value), value).toEqual({ reason: "value-expansion" });
    }
  });
});
