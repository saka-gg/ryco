const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

/**
 * The code-signing certificate's path differs between an EAS build (a secret file variable) and
 * the publisher's machine (a local file), but only its contents decide which updates a binary
 * accepts. The Expo config enters the fingerprint (runtimeVersion) as JSON, path included, so a
 * signed build and its updates would never match: hash the certificate instead of its path.
 * Every other source passes through untouched, and an unsigned config hashes as before.
 *
 * @type {import("expo/fingerprint").Config["fileHookTransform"]}
 */
function hashCodeSigningCertificateContents(source, chunk) {
  if (source.type !== "contents" || source.id !== "expoConfig" || typeof chunk !== "string") {
    return chunk;
  }
  let config;
  try {
    config = JSON.parse(chunk);
  } catch {
    return chunk;
  }
  const certificatePath = config?.updates?.codeSigningCertificate;
  if (typeof certificatePath !== "string") return chunk;
  const certificate = readFileSync(resolve(__dirname, certificatePath), "utf8")
    .replaceAll("\r\n", "\n")
    .trim();
  config.updates.codeSigningCertificate = `sha256:${createHash("sha256").update(certificate).digest("hex")}`;
  return JSON.stringify(config);
}

// Bun's isolated linker keeps every package under node_modules/.bun/<id>/node_modules/,
// which @expo/fingerprint's default `**/node_modules/**/node_modules/**` ignore matches,
// and its defaults cannot be removed. Autolinked native packages are therefore hashed
// only by name, version and path, so a native patch from the root patches/ would never
// move the fingerprint (runtimeVersion). Hash the patches themselves. JS-only patches
// move it too, which only ever errs towards a new runtime.
/** @type {import("expo/fingerprint").Config} */
module.exports = {
  extraSources: [{ type: "dir", filePath: "../../patches", reasons: ["rycoPatches"] }],
  fileHookTransform: hashCodeSigningCertificateContents,
};
