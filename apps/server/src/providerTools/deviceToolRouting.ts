/**
 * The short routing rules a session with Ryco's device tools gets in its instructions, so
 * the agent reaches for them (not simctl or adb) before it has ever called one. The longer
 * how-to rides on the first result each agent gets (`deviceToolGuidance.ts`).
 *
 * Delivered where each provider keeps session instructions: Claude's appended system prompt
 * (and its native subagents through a SubagentStart hook), Codex's developer instructions,
 * and the first-turn instructions of the others (`ProviderService`, while the thread holds a
 * device tool binding). Adapted from t3code's device routing block
 * (packages/provider-core/src/server/orchestrationInstructions.ts; see THIRD_PARTY_NOTICES.md).
 *
 * On the boot path (the adapters import it), so it stays a string.
 *
 * @module providerTools/deviceToolRouting
 */

export const DEVICE_ROUTING_INSTRUCTIONS = `<ryco_devices>
Ryco gives you its iOS Simulators and Android Emulators through the ryco_device tools: device_read (list, describe_ui, screenshot, wait, logs) and device (tap, type, swipe, press_button, scroll_to_element, launch, open_url, boot, install, configure). If they are deferred, load them with tool search first (query "ryco_device").
- Use them for everything on a device screen: reading it, tapping, typing, gestures, launching apps, opening links. Never drive device UI with xcrun simctl io/ui, idb, adb shell input, AppleScript or by opening Simulator.app.
- Keep the shell for builds (xcodebuild, gradle, expo prebuild), Metro, and logs device_read cannot give you.
- If a device action fails, read the error and try one fix. If it fails again, stop and tell the user what failed; do not loop or switch to shell workarounds.
- When you hand device work to a subagent, give it the device udid.
</ryco_devices>`;
