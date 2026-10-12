/**
 * The desktop Computer-use stack (CUA driver host, app snapping, browser
 * bridge, overlay), loaded by `main.ts` through `import()` once Electron is
 * ready rather than on the pre-ready path every launch evaluates.
 */
export { DesktopComputerUseRuntime } from "./runtime.ts";
export { registerComputerUseIpc } from "./ipc.ts";
export { registerProjectBrowserIpc } from "../browser/ipc.ts";
