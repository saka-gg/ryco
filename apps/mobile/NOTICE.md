# Third-party notices — @ryco/mobile

The `apps/mobile` scaffold — the Expo/React Native app shell and its build
configuration (`app.config.ts`, `metro.config.js`, `babel.config.js`,
`index.ts`, `global.css`, `eas.json`, the `plugins/*` config plugins, and the
platform/runtime wiring modeled on them) — was copied and stripped from
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) at commit `67a7b1a1`
(originally `apps/mobile`). It was re-namespaced from T3 to Ryco identifiers,
re-themed, and had the T3-proprietary planes (the hosted-auth vendor and managed
cloud, EAS project/owner, brand assets, telemetry endpoint, widgets, share
extension, quick actions, and the camera-showcase rig) removed for the Ryco MVP.

The B2 screen layer copied from the same upstream reference at the same commit
extends this copy: the native JS view wrappers (`src/native/*`), the shared UI
primitives (`src/components/*`), the shared helpers (`src/lib/*`), the review
diff/highlighting modules (`src/features/review/*`), the hardware-keyboard
command registry (`src/features/keyboard/*`), the appearance text-scaling hook
(`src/features/settings/appearance/*`), and further B2 modules that reuse upstream
logic verbatim or near-verbatim: the workspace connection-status helpers
(`src/features/home/workspace-connection-status.ts`), the pairing URL / QR helpers
(`src/features/connection/pairing.ts`), the terminal font-size preferences
(`src/features/terminal/terminalPreferences.ts`), and the state helpers ported
from upstream — the device-preferences `Preferences` shape + `sanitizePreferences`
(`src/state/preferencesStore.ts`) and the outbox delivery/retry model
(`src/state/threadOutboxModel.ts`). All were copied and stripped the same way —
re-namespaced from T3 to Ryco identifiers (including the native view names
`RycoComposerEditor` / `RycoNativeControls` / `RycoKeyboardCommands` /
`RycoReviewDiffSurface`), re-themed to the `font-ryco-*` utilities, and with the
brand marks, cloud plane, showcase rig, and asset-runtime dependencies removed.
Attribution is kept here (not as in-file headers) so the T3 identifiers do not
re-enter `src`.

The 2026-11 everyday-handling round ported further modules from the same
upstream (at `e455200077`), adapted to Ryco's runtime and re-themed the same
way: the thread row swipe actions and their dismissal animation
(`src/features/threadList/ThreadSwipeable.tsx`, `threadSwipeModel.ts`,
`threadDismissal.ts`; upstream `features/home/thread-swipe-actions.tsx`,
`thread-dismissal.ts`), the swipe-to-dismiss Undo toast behavior
(`src/components/SidebarUndoNoticeHost.tsx`; upstream `components/ui/Toast.tsx`,
`features/home/ThreadUndoNotice.tsx`), the home-screen quick actions
(`src/features/shortcuts/*`; upstream `features/shortcuts/appShortcuts.ts`,
`appShortcutsRuntime.ts`), and the streaming-reply haptics
(`src/features/threads/threadStreamHaptics.ts`; upstream
`features/threads/threadStreamHaptics.ts`).

The composer round (2026-11) ports further upstream modules from `pingdotgg/t3code`
at commit `e455200077`, adapted to Ryco's shared trigger and ranking logic: the
autocomplete menu (`src/features/threads/composerCommandMenuModel.ts`,
`useComposerCommandMenu.ts` and `ComposerCommandPopover.tsx`, from upstream's
`use-composer-command-menu.ts`, `composerSlashSkillSearch.ts` and
`ComposerCommandPopover.tsx`), the attach menu and Files-app picking
(`src/components/ComposerAttachMenu.tsx` and `pickComposerDocuments` in
`src/lib/composerFiles.ts`, from upstream's `ComposerAttachmentButton.tsx` and
`composerImages.ts`), and the share-extension display-name config plugin
(`plugins/withShareExtensionDisplayName.cjs`, verbatim), and the dictation
controls (`src/features/dictation/ComposerDictationControls.tsx`, after upstream's
`voice-input/ComposerDictationControl.tsx` and `voiceInputMetering.ts`; Ryco
recognizes speech on the device instead of transcribing on a server), and the
incoming-share model (`src/features/sharing/incomingShareModel.ts`, after upstream's
`sharing/incoming-share-model.ts` and `incoming-share-native.ts`).

The notification and Live Activity work ports mechanisms and numbers from the same
upstream at a later commit (`e4552000`), rewritten for Ryco rather than copied: the
foreground rule that keeps an alert for the thread on screen quiet and the
once-per-response tap routing including the response that launched the app
(`src/notifications/threadAlerts.ts`, `threadAlerts.logic.ts`, from upstream's
`foregroundNotificationBehavior.ts` / `notificationResponseConsumer.ts`); the agent
card's row content (project, model, phase, status), its lead-row order and phase
tints (`modules/ryco-widgets/extension/AgentActivityWidget.swift`,
`AgentGlance.swift`, from upstream's `widgets/AgentActivity.tsx` and the relay's
aggregate row); and the Live Activity push timings documented in
`docs/live-activity-push.md` (ten-minute stale date, end dismissal windows, from
upstream's relay APNs client).

The Usage tab (round 2, 2026-11) follows the layout and mechanisms of the same
upstream's phone Usage screen at `e455200077`, rewritten for Ryco's statistics
components rather than copied: the view switch above a date-window switch, the
keyed fade-in per view, the loading, empty and per-device error states, the
delayed dimming while devices answer a refresh, and refreshing limits when they
come back into view at most once per five minutes plus on pull
(`src/features/usage/UsageTabScreen.tsx`, `usageTabModel.ts`,
`useLimitsFocusRefresh.ts`, from upstream's `features/usage/UsageRouteScreen.tsx`,
`UsageLimitsSection.tsx` and `usageLimitsRefresh.ts`).

The tab bar (round 2, 2026-11) uses the same upstream's tab icon choices at `ade473018d`
(`features/layout/workspace/navigation-tabs.ts`, `WorkspaceNativeTabs.ios.tsx`):
`text.bubble` / `text.bubble.fill`, `chart.bar.xaxis`, `gearshape`, and its pull request
template image, copied verbatim as `assets/icons/pull-request.png` (with `@2x` and `@3x`)
from upstream's `apps/mobile/assets/icons/`.

`pingdotgg/t3code` is Copyright (c) 2026 T3 Tools Inc. and licensed under the MIT
License; that notice is retained below as required. The four vendored native
modules under `modules/*` carry their own `LICENSE` / `UPSTREAM.md` notices
(including the react-native-uitextview / Bluesky PBC origin of the markdown
module and the Expo template origin of the composer module).

## pingdotgg/t3code MIT notice

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
