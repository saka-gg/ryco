/**
 * Installs the fatal error recorder as a side effect. `index.ts` imports this bare, right after
 * the polyfills: imports are hoisted and Metro never inlines a bare import, so it evaluates
 * before any other module of the app (`metroStartupConfig.test.ts`), and a crash while the
 * rest loads is kept too.
 */
import { type ErrorUtilsLike, installFatalErrorRecorder } from "./fatalErrorRecorder";
import { fatalErrorFileStore } from "./fatalErrorStore";

installFatalErrorRecorder({
  errorUtils: (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils,
  store: fatalErrorFileStore,
});
