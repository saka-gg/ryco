// FILE: sourceControlHostExports.ts
// Purpose: `sourceControl.ts` re-exports the host detection through this barrel, not from
//          `sourceControlHost.ts` itself: the web build's boot graph does not enter re-export
//          barrels (`apps/web/src/viteBuild/codeSplitting.ts`), so a lazy surface that detects a
//          pasted URL's provider keeps that code out of the boot chunk, which imports
//          `sourceControl.ts` through `git.ts`.
// Layer: Shared. Only re-exports.

export { detectSourceControlProviderFromRemoteUrl } from "./sourceControlHost.ts";
