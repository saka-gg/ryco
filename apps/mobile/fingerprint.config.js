// Bun's isolated linker keeps every package under node_modules/.bun/<id>/node_modules/,
// which @expo/fingerprint's default `**/node_modules/**/node_modules/**` ignore matches,
// and its defaults cannot be removed. Autolinked native packages are therefore hashed
// only by name, version and path, so a native patch from the root patches/ would never
// move the fingerprint (runtimeVersion). Hash the patches themselves. JS-only patches
// move it too, which only ever errs towards a new runtime.
/** @type {import("expo/fingerprint").Config} */
module.exports = {
  extraSources: [{ type: "dir", filePath: "../../patches", reasons: ["rycoPatches"] }],
};
