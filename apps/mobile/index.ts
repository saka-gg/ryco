import "./polyfills";
// Import-time registrations. Metro inlines requires (metro.config.js), so a
// module is evaluated at its first use; bare imports are never inlined, which
// keeps these lazy configurators registered at startup, before any runtime
// code can ask for its configuration.
import "./src/state/threadsRuntime";
import "./src/hostedHub/state";

import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { featureFlags } from "react-native-screens";

import App from "./src/App";

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

// The relay-E2EE vector runner is a development-build diagnostic, and this is
// the only reference to it anywhere in the app graph. Metro replaces `__DEV__`
// and folds the dead branch away BEFORE it collects dependencies, so a release
// bundle contains neither the `require` nor the module it names; the runner's
// own `APP_VARIANT` check is the second gate. See apps/mobile/README.md.
if (__DEV__) {
  (
    require("./src/devtools/e2eeVectorRunner") as typeof import("./src/devtools/e2eeVectorRunner")
  ).installE2eeVectorRunnerDevHook();
}

registerRootComponent(App);
