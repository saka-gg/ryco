import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_UPDATE_CODE_SIGNING_METADATA,
  resolveMobileRepoRoot,
  resolveMobileUpdates,
} from "./env";

const PROJECT_ID = "0f8a2c9e-1234-4abc-9def-0123456789ab";
const PROJECT_ROOT = "/workspace/apps/mobile";

// A self-signed public certificate made for this test (its private key was discarded).
const CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBbjCCARSgAwIBAgIUX5DziUgh5yi6H+S1DkwLc539f3kwCgYIKoZIzj0EAwIw",
  "HDEaMBgGA1UEAwwRcnljby10ZXN0LXVwZGF0ZXMwIBcNMjYxMDMxMDMzMzU4WhgP",
  "MjEyNjEwMDcwMzMzNThaMBwxGjAYBgNVBAMMEXJ5Y28tdGVzdC11cGRhdGVzMFkw",
  "EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEiwRXouCZWAQWK39V0FxqS9XlmyvU4Mz0",
  "2b3LJT3GcDHtwxdrXo5P3tI5uYrVSdxoReAgrxBh1CVUpN8xPhf5naMyMDAwHQYD",
  "VR0OBBYEFAH1dWjYNep+bOHQXP+8RV0LV1tWMA8GA1UdEwEB/wQFMAMBAf8wCgYI",
  "KoZIzj0EAwIDSAAwRQIhAJZXyKYw/YVrN+oR/d3sfrKNbj8EghxpFIEV+xR160c1",
  "AiA/AZS6DM5sAvVVs/t/dqqOnrCd7boBKJUiQR2O6cmCuA==",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

function readFrom(files: Record<string, string>) {
  return (path: string) => {
    const file = files[path];
    if (file === undefined) throw new Error(`ENOENT: ${path}`);
    return file;
  };
}

describe("mobile environment root", () => {
  it("resolves the monorepo root from apps/mobile/config", () => {
    expect(resolveMobileRepoRoot("file:///workspace/apps/mobile/config/env.ts")).toBe("/workspace");
  });
});

describe("over-the-air updates", () => {
  it("stay off without an EAS project", () => {
    for (const projectId of [undefined, "  "]) {
      expect(resolveMobileUpdates({ projectId, runtimePolicy: "fingerprint" })).toEqual({
        updates: { enabled: false },
        projectId: null,
        signed: false,
      });
    }
  });

  it("never check for an update without a signing certificate", () => {
    expect(resolveMobileUpdates({ projectId: PROJECT_ID, runtimePolicy: "fingerprint" })).toEqual({
      updates: {
        enabled: true,
        url: `https://u.expo.dev/${PROJECT_ID}`,
        checkAutomatically: "NEVER",
        fallbackToCacheTimeout: 0,
      },
      projectId: PROJECT_ID,
      signed: false,
    });
  });

  it("verify every update against the configured certificate", () => {
    const certificatePath = "/secrets/eas/update-certificate.pem";
    const result = resolveMobileUpdates({
      projectId: PROJECT_ID,
      certificatePath,
      runtimePolicy: "fingerprint",
      projectRoot: PROJECT_ROOT,
      readFile: readFrom({ [certificatePath]: CERTIFICATE }),
    });
    expect(result).toEqual({
      updates: {
        enabled: true,
        url: `https://u.expo.dev/${PROJECT_ID}`,
        // The app owns when to check; the native controller never checks on its own.
        checkAutomatically: "NEVER",
        fallbackToCacheTimeout: 0,
        codeSigningCertificate: "../../../secrets/eas/update-certificate.pem",
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      },
      projectId: PROJECT_ID,
      signed: true,
    });
    // expo-updates joins the configured path onto the project root.
    expect(
      NodePath.join(
        PROJECT_ROOT,
        (result.updates as { codeSigningCertificate: string }).codeSigningCertificate,
      ),
    ).toBe(certificatePath);
    expect(MOBILE_UPDATE_CODE_SIGNING_METADATA).toEqual({ keyid: "main", alg: "rsa-v1_5-sha256" });
  });

  it("resolve a relative certificate path from apps/mobile", () => {
    const result = resolveMobileUpdates({
      projectId: PROJECT_ID,
      certificatePath: "certs/update.pem",
      runtimePolicy: "fingerprint",
      projectRoot: PROJECT_ROOT,
      readFile: readFrom({ [`${PROJECT_ROOT}/certs/update.pem`]: CERTIFICATE }),
    });
    expect(result.updates).toMatchObject({ codeSigningCertificate: "certs/update.pem" });
  });

  it("refuse a certificate file that is missing, not a certificate, or a private key", () => {
    const certificatePath = "/secrets/update.pem";
    const resolveWith = (pem: string | undefined) => () =>
      resolveMobileUpdates({
        projectId: PROJECT_ID,
        certificatePath,
        runtimePolicy: "fingerprint",
        projectRoot: PROJECT_ROOT,
        readFile: readFrom(pem === undefined ? {} : { [certificatePath]: pem }),
      });
    expect(resolveWith(undefined)).toThrow(/names no readable file/u);
    expect(resolveWith("not a pem")).toThrow(/must be a PEM certificate/u);
    expect(resolveWith(CERTIFICATE.replace("MIIBbjCC", "MIIBbjXX"))).toThrow(
      /must be a PEM certificate/u,
    );
    const privateKeyHeader = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
    expect(resolveWith(`${privateKeyHeader}\nAAAA\n`)).toThrow(/never the private key/u);
  });

  it("refuse signing without the fingerprint runtime version", () => {
    expect(() =>
      resolveMobileUpdates({
        projectId: PROJECT_ID,
        certificatePath: "/secrets/update.pem",
        runtimePolicy: "appVersion",
        projectRoot: PROJECT_ROOT,
        readFile: readFrom({ "/secrets/update.pem": CERTIFICATE }),
      }),
    ).toThrow(/fingerprint runtime version/u);
  });

  it("refuses anything that is not a project id", () => {
    expect(() =>
      resolveMobileUpdates({ projectId: "https://u.expo.dev/x", runtimePolicy: "fingerprint" }),
    ).toThrow(/RYCO_EAS_PROJECT_ID/u);
  });

  it("are never fetched by app code", () => {
    // Native checks are NEVER, so nothing fetches an update unless app code asks for one.
    // A check, fetch or reload belongs to one owner that refuses while `extra.updates.signed`
    // is false; until it exists, no app source may call them.
    const SOURCE_ROOTS = ["src", "index.ts"].map((entry) =>
      NodePath.join(import.meta.dirname, "..", entry),
    );
    const offenders: string[] = [];
    const visit = (path: string) => {
      const stat = NodeFS.statSync(path);
      if (stat.isDirectory()) {
        for (const entry of NodeFS.readdirSync(path)) visit(NodePath.join(path, entry));
        return;
      }
      if (!/\.(?:ts|tsx)$/u.test(path)) return;
      const text = NodeFS.readFileSync(path, "utf8");
      if (
        /\b(?:checkForUpdateAsync|fetchUpdateAsync|reloadAsync|checkAutomatically)\b/u.test(text)
      ) {
        offenders.push(NodePath.relative(NodePath.join(import.meta.dirname, ".."), path));
      }
    };
    for (const root of SOURCE_ROOTS) visit(root);
    expect(offenders).toEqual([]);
  });
});
