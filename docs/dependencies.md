# Dependency compatibility

Install with the Bun version in `packageManager` and `bun install --frozen-lockfile`.
The lockfile uses version 3 for parent-scoped overrides; do not regenerate it with an
older Bun release. The standalone `marketing` app has its own manifest and lockfile.

## Coupled upgrades

- Keep `vite-plus` and the `vite` alias on the same release. Vite Plus 0.3.1 bundles
  Vitest 4.1.11 and requires the matching browser provider. Vitest 5 is not a compatible
  independent upgrade. The root Oxfmt and Oxlint versions match Vite Plus's bundled tools.
- Keep TypeScript and `@effect/tsgo` compatible; tsgo 0.43.0 supports TypeScript 7.0.2.
- Upgrade Expo using its `bundledNativeModules.json` and `expo install --check`.
  Expo 57.0.21 expects React 19.2.3, React Native 0.86.3, keyboard-controller 1.21.9,
  gesture-handler 2.32.x, screens 4.26.x, Reanimated 4.5.1, and Worklets 0.10.1.
  Newer npm releases are not necessarily compatible with this SDK.
- Nitro Markdown 0.10.0 requires Nitro Modules `>=0.36.5 <0.37.0`. Retain the patched
  0.36.5 until the markdown integration is migrated as a unit.
- Effect remains on the beta.107 family with its custom RPC lifecycle hooks. Moving
  to an Effect release candidate requires porting the RPC patch and checking every
  consumer; selecting npm's `latest` tag would instead choose Effect 3.
- Noble remains at the exact 2.3.0 versions recorded in the
  [protocol's dependency policy](relay-e2ee-protocol.md#142-primitive-dependencies-and-audit-lineage).
  A cryptographic dependency upgrade is a separate protocol change. CBOR upgrades
  must update `E2EE_CBOR_CODEC` and pass the byte-exact vector corpus.
- Electron 44 requires macOS 13 or newer. Its clipboard writes are asynchronous;
  menu callbacks must handle rejected promises. Keep the packaging minimum OS in sync.

## Security overrides

The root overrides pin fixed versions of `fast-uri`, `qs`, `@xmldom/xmldom`, and
`browserslist`, alongside the existing security pins. Refresh transitive resolutions
as well as direct dependencies when auditing; an unchanged parent can otherwise retain
an old vulnerable child.

Two fixes are deliberately scoped to their consumers:

- `xcode>uuid` selects 11.1.1, which still supports CommonJS. A global override would
  also change Effect's newer UUID dependency.
- `query-string>decode-uri-component` selects 0.5.0. This release is ESM, so the
  `query-string@7.1.3` patch reads its default export. Keep the override and patch
  together until React Navigation updates its query-string dependency. The mobile
  dependency compatibility tests exercise both consumer paths.

As of 2026-09-08, Metro's `image-size` dependency still has two reported parser
denial-of-service advisories, and npm's latest release, 2.0.2, is also affected:
[ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
[JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
No version override is applied without a fixed, compatible target. Recheck the
upstream release and Metro integration before closing these audit findings.

## Local patches

Versioned patches contain application behavior as well as packaging fixes. Port
them against pristine upstream source and compare the resulting behavior before
changing `patchedDependencies`. In particular, the list, navigation, and Expo JSI
patches must survive upgrades. The Pierre patch exposes the mobile parser and type
subpaths without importing the browser entry point.

After upgrading MSW, regenerate `apps/web/public/mockServiceWorker.js` with the
installed CLI. This is the development/test worker, distinct from the hosted PWA's
static-shell service worker.
