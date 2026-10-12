import { runShellEnvironmentWorker } from "@ryco/shared/shellEnvironment";

// Shell profiles and executable discovery can block on an unavailable filesystem.
// Keep them outside Electron's main thread, including on Windows.
runShellEnvironmentWorker();
