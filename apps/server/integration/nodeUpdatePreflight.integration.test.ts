/**
 * The node update preflight, as the release being replaced runs it: `ryco node-update-preflight
 * --database <copy>` loads the whole server graph, migrates the copy, and reports on stdout
 * without listening or creating the node's own state.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import { SUPPORTED_MIGRATION_ID } from "../src/persistence/Migrations.ts";
import {
  NODE_UPDATE_PREFLIGHT_PASSED,
  NODE_UPDATE_PREFLIGHT_STARTED,
} from "../src/nodeUpdate/updateProtocol.ts";

const SERVER_ROOT = NodePath.join(import.meta.dirname, "..");
const BIN = NodePath.join(SERVER_ROOT, "src/bin.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const preflight = (database: string, home: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [BIN, "node-update-preflight", "--database", database],
      {
        cwd: SERVER_ROOT,
        // What the service's own environment passes on to the release it checks.
        env: { ...process.env, RYCO_HOME: home, RYCO_SERVICE_LABEL: "space.ryco.node.test" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });

describe("node update preflight", () => {
  it("migrates the copy it is given and touches nothing else", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-preflight-"));
    dirs.push(dir);
    const home = NodePath.join(dir, "home");
    const copy = NodePath.join(dir, "preflight.sqlite");
    // An empty file is an empty database: the preflight runs every migration on it.
    NodeFS.writeFileSync(copy, "");

    const result = await preflight(copy, home);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(result.stdout.trim().split("\n")).toEqual([
      NODE_UPDATE_PREFLIGHT_STARTED,
      `${NODE_UPDATE_PREFLIGHT_PASSED} ${packageJson.version}`,
    ]);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      expect(db.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get()).toEqual(
        { id: SUPPORTED_MIGRATION_ID },
      );
    } finally {
      db.close();
    }
    expect(NodeFS.existsSync(home)).toBe(false);
  });

  it("fails after announcing itself when the copy cannot be migrated", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-preflight-"));
    dirs.push(dir);
    const copy = NodePath.join(dir, "preflight.sqlite");
    NodeFS.writeFileSync(copy, "not a database ".repeat(64));

    const result = await preflight(copy, NodePath.join(dir, "home"));
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe(NODE_UPDATE_PREFLIGHT_STARTED);
    expect(result.stderr).toContain(
      `Ryco ${packageJson.version} could not migrate the database copy`,
    );
  });
});
