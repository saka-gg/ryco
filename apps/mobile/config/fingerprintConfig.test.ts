import * as NodeFS from "node:fs";
import { createRequire } from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { UPDATE_SIGNING_CERTIFICATE } from "./testCertificates";

const require = createRequire(import.meta.url);
const { fileHookTransform } = require("../fingerprint.config.js") as {
  fileHookTransform: (
    source: { type: "contents"; id: string } | { type: "file"; filePath: string },
    chunk: string | Buffer | null,
    isEndOfFile: boolean,
    encoding: string,
  ) => string | Buffer | null;
};

const MOBILE_ROOT = NodePath.join(import.meta.dirname, "..");
const CERTIFICATE = UPDATE_SIGNING_CERTIFICATE;

const expoConfig = (codeSigningCertificate?: string) =>
  JSON.stringify({
    name: "Ryco",
    updates: {
      enabled: true,
      checkAutomatically: "NEVER",
      ...(codeSigningCertificate === undefined ? {} : { codeSigningCertificate }),
    },
  });
const transform = (contents: string) =>
  fileHookTransform({ type: "contents", id: "expoConfig" }, contents, true, "utf8");

describe("the mobile fingerprint", () => {
  it("hashes the update certificate's contents, not where the file lives", () => {
    const directories = [0, 1].map((index) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `ryco-cert-${index}-`));
      NodeFS.writeFileSync(NodePath.join(directory, "update.pem"), CERTIFICATE);
      return NodePath.relative(MOBILE_ROOT, NodePath.join(directory, "update.pem"));
    });
    const [onEas, onPublisher] = directories.map((path) => transform(expoConfig(path)));
    expect(onEas).toBe(onPublisher);
    expect(String(onEas)).toMatch(/"codeSigningCertificate":"sha256:[0-9a-f]{64}"/u);
    expect(String(onEas)).not.toContain("update.pem");
  });

  it("moves when the certificate itself changes", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-cert-"));
    const path = NodePath.join(directory, "update.pem");
    NodeFS.writeFileSync(path, CERTIFICATE);
    const before = transform(expoConfig(NodePath.relative(MOBILE_ROOT, path)));
    NodeFS.writeFileSync(path, CERTIFICATE.replace("MIIDHzCC", "MIIDHzCD"));
    expect(transform(expoConfig(NodePath.relative(MOBILE_ROOT, path)))).not.toBe(before);
  });

  it("leaves an unsigned config and every file source as they were", () => {
    const unsigned = expoConfig();
    expect(transform(unsigned)).toBe(unsigned);
    const chunk = Buffer.from("native source");
    expect(fileHookTransform({ type: "file", filePath: "ios/Podfile" }, chunk, false, "utf8")).toBe(
      chunk,
    );
  });
});
