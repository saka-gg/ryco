/**
 * The license manifest `scripts/generate-third-party-licenses.mts` writes and Metro resolves
 * (`metro.config.js`); decode it with `decodeThirdPartyLicenseManifest`.
 */
declare module "@ryco/mobile-third-party-licenses" {
  const manifest: unknown;
  export = manifest;
}
