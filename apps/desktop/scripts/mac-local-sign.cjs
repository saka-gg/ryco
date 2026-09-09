const { createRequire } = require("node:module");

// electron-builder 26 replaces an already resolved certificate hash with its
// display name. Xcode certificate renewals can share that name, so codesign
// rejects it as ambiguous. Preserve the exact hash and revalidate that identity
// with osx-sign before signing all nested code using the normal builder options.
module.exports = async function signLocalMacApp(options) {
  if (!/^[A-Fa-f0-9]{40}$/.test(options.identity ?? "")) {
    throw new Error("Local macOS signing requires an exact development certificate hash.");
  }
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
  const { signAsync } = appBuilderRequire("@electron/osx-sign");
  await signAsync({ ...options, identityValidation: true });
};
