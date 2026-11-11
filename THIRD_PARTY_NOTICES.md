# Third-party notices

This repository contains original Ryco work and modifications alongside code
derived from third-party projects. The notices below apply to the corresponding
upstream portions and do not change the license for Ryco's original work.

## pingdotgg/t3code

Portions of Ryco were derived from [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code),
including code copied or adapted from the upstream project at commit
`67a7b1a1`. The upstream project is Copyright (c) 2026 T3 Tools Inc. and is
licensed under the MIT License.

`apps/web/src/markdown-incremental.ts` is adapted from PR #11193 at commit
`a9dabbf100d1f6c0b2ed7b5e879d469ac14fd186`, under the same copyright and license.

The OpenCode 2 recordings in `apps/server/src/provider/__fixtures__/opencode2/` (sessions recorded
against OpenCode 2.0.18) are copied from
`apps/server/src/orchestration-v2/testkit/fixtures/opencode2_*/opencode_transcript.ndjson` at
commit `91992bd5d464d6a01b2a5c1e7926e68ad09ea40e`, under the same copyright and license.

The provider replay test helpers in `apps/server/src/provider/testUtils/replay/` adapt
upstream's replay testkit at commit `91992bd5d464d6a01b2a5c1e7926e68ad09ea40e`, under the same
copyright and license.

The device tool routing rules (`apps/server/src/providerTools/deviceToolRouting.ts`), their
delivery to Claude native subagents through a SubagentStart hook, and the device routing eval in
`evals/device-routing/` adapt upstream's device instructions
(`packages/provider-core/src/server/orchestrationInstructions.ts`) and its `evals/mcp-tool-use`
device cases at commit `6577c6b6`, under the same copyright and license.

The open source license manifest is adapted from upstream at commit `ade473018d`, under the same
copyright and license: its generator and SPDX template handling
(`scripts/lib/third-party-licenses.ts`, `scripts/sync-third-party-license-notices.ts`, from
upstream's `scripts/lib/third-party-licenses.ts` and `sync-third-party-license-notices.ts`), the
manifest decoding and search (`packages/shared/src/thirdPartyLicenses.ts`), its generation before
Metro starts and lazy loading in the phone app (`apps/mobile/metro.config.js`,
`apps/mobile/src/features/settings/mobileThirdPartyLicenses.ts`), the license screens
(`SettingsOpenSourceLicensesRouteScreen.tsx`) and the committed SPDX templates in
`third-party-licenses/spdx/` (from the SPDX License List, CC0-1.0).

The simulator pane's live input follows upstream's device stream at commit
`6577c6b6` (`packages/client-runtime/src/device/stream.ts`,
`apps/web/src/components/device/DeviceStreamView.tsx`), under the same copyright and license:
touches streamed as down, move and up while the pointer moves
(`apps/web/src/components/device/useDeviceTouchInput.ts`), chunked paste
(`useDeviceKeyboardInput.ts`, `packages/shared/src/deviceLiveInput.ts`), and the decode-queue
guard and stall watchdog in `packages/client-runtime/src/deviceVideo/decoder.ts` (shared by
`apps/web/src/components/device/useDeviceVideoStream.ts` and the phone's device viewer).

The phone's device viewer follows upstream's mobile device preview at commit `6577c6b6`
(`apps/mobile/src/features/devices/DeviceStreamWebView.tsx`, `device-stream.browser.ts`,
`DevicePreviewRouteScreen.tsx`): H.264 decoded with WebCodecs inside a WebView, touches reported
from the page in normalized frame coordinates, a device picker, and the iPad side panel
(`apps/mobile/src/features/devices/`), under the same copyright and license.

The device workspace follows upstream at the same commit, under the same copyright and license:
the floating window's store, layout and drag and resize model
(`apps/web/src/previewMiniPlayerStore.ts`,
`apps/web/src/components/preview/previewMiniPlayerLayout.ts` and `ThreadPreviewMiniPlayer.tsx`)
in `apps/web/src/deviceWorkspace/workspaceMiniPlayerStore.ts`, `workspaceMiniPlayerLayout.ts` and
`WorkspaceMiniPlayerFrame.tsx`; and the grouped Start/Open device list
(`apps/web/src/components/device/DevicePanel.tsx`) in
`apps/web/src/components/device/DevicePicker.tsx`.

The device setup, Tools drawer and SSH host settings follow upstream at commit `6577c6b6`, under
the same copyright and license: the three setup steps and per-platform status
(`apps/web/src/components/device/DeviceSetup.tsx`) in `DeviceSetupWizard.tsx`; the drawer's
control set, platform filtering and read-back after each action
(`apps/web/src/components/device/DeviceToolsPanel.tsx`, `apps/server/src/device/DeviceActions.ts`)
in `DeviceToolsDrawer.tsx`, `apps/server/src/device/iosDeviceDetail.ts` and
`apps/server/src/device/android/androidDetail.ts` (including the Android animation-scale Reduce
Motion and `dumpsys window` focus reading); and the host list with Test connection
(`apps/web/src/components/settings/DeviceSourcesSettings.tsx`, `DeviceHostEditor.tsx`) in
`apps/web/src/components/settings/DeviceHostsSettings.tsx`.

The device panel's 3D view follows upstream's procedural device path at commit `6577c6b6`, under
the same copyright and license, without its device models (`apps/web/src/components/device/models`,
which upstream marks as having no redistribution license): the extruded body with glass and metal
materials and the live stream canvas as its screen texture
(`packages/client-runtime/src/device/phoneScene.ts`, `shapeProfile.ts`, `phoneViewer.ts`), the
render-on-change scheduler (`renderScheduler.ts`), spring-damped rotation and framing
(`deviceMotion.ts`, `deviceFraming.ts`), view snapping (`deviceViewSnap.ts`), press-on-screen to
touch and press-off-screen to orbit (`phoneInteraction.ts`,
`apps/web/src/components/device/DevicePhoneViewport.tsx`, `mountDeviceViewer.ts`) and trackpad
orbit and pinch (`apps/web/src/components/device/phoneTrackpad.ts`), in
`apps/web/src/components/device/scene3d/` and `DeviceView3D.tsx`.

### MIT License

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

Package-specific notices, including the notices for the native mobile modules,
are retained in their respective package directories.

## Emanuele-web04/synara

The iOS Simulator device contracts, native helper, server lifecycle and transport logic, web
interaction logic, and related tests were copied or adapted from
[`Emanuele-web04/synara`](https://github.com/Emanuele-web04/synara) tag `v0.7.2`, primarily feature
commit `467d2f21` (`feat(device): iOS Simulator pane (#529)`). The upstream work is Copyright (c)
2026 T3 Tools Inc. and Copyright (c) 2026 Emanuele Di Pietro and is licensed under the MIT License.
The SVG device chassis in `apps/web/src/components/device/DeviceFrame.tsx` was subsequently adapted
from Synara commit `dd88d9272f97e4dda5735281e73ce14de388ad25` under the same license.
The idle release of Ryco-owned simulators after their last consumer settles was adapted from Synara
commit `d419d5d40` (#1966) under the same license. Agent device tool evidence (screen settling, the
compact screen snapshot), device_wait and the simulator log reader were adapted from Synara commit
`74e0b3654` (#1924) under the same license. The per-task consent for agent device input and its
"Allow Device for this task" wording follow Synara commit `299fd573b` under the same license. The
Xcode 27 SimulatorKit lookup and the dtuhidd input transport in the native helper
(`DTUHIDTransport.h/.m`, the HID bridge's delivery accounting and the server's replay rules) were
adapted from Synara commits `dbfb2ae1a` (#687) and `74e0b3654` (#1924) under the same license;
Synara learned the dtuhidd wire format from facebook/idb's MIT-licensed FBSimulatorControl HID
sources.
Browser element picking heuristics (selector, role, accessible name, sensitive-element,
sensitive-text and URL-redaction checks) and field limits in
`packages/shared/src/browserElementPickScript.ts`, `packages/shared/src/browserElementReference.ts`
and `packages/contracts/src/browserElementLimits.ts` were adapted from Synara commit
`299fd573b1d6520c323a87c78d30be74e87e53e1` (`apps/desktop/src/browserAnnotations/guestPreload.ts`,
`protocol.ts`, `packages/shared/src/browserAnnotations.ts`,
`packages/contracts/src/browserAnnotations.ts`) under the same license.
The built-in browser's console/network diagnostics, network idle window, page-dialog policy and dialog
shim, and expected agent input matching (`apps/desktop/src/computerUse/browserDiagnostics.ts` and
`browserTabAutomation.ts`) were adapted from Synara commit `8f6521a67` (v0.6.4, PR #444) and main
`299fd573b` under the same license, and the browser upload staging rules
(`apps/desktop/src/computerUse/browserUploads.ts` and
`apps/server/src/agentControl/Mcp/browserUploadStaging.ts`) from `workspaceUpload.ts` of the same
Synara commit `8f6521a67`.
The OpenCode 2 client and mappings in `apps/server/src/provider/openCodeV2Client.ts`,
`openCodeV2Mapping.ts` and `openCodeV2Events.ts` are adapted from Synara's `openCodeV2Client.ts`,
`openCodeV2Mapping.ts` and `openCodeV2Messages.ts` at commit
`ea912dcf14a38c12f30ebc3bfdf80af6ca446bea`, under the same license.
The streaming Markdown block splitter and block renderer in `apps/web/src/markdown-blocks.ts` and
their tests are adapted from Synara's `apps/web/src/components/chat/streamingMarkdownBlocks.ts` at
commit `bba7dcb8c9d46512e8abac2510dff80a7782b98e` (#1963), under the same license.

The device panel's 3D view follows upstream's procedural device path at commit `6577c6b6`, under
the same copyright and license, without its device models (`apps/web/src/components/device/models`,
which upstream marks as having no redistribution license): the extruded body with glass and metal
materials and the live stream canvas as its screen texture
(`packages/client-runtime/src/device/phoneScene.ts`, `shapeProfile.ts`, `phoneViewer.ts`), the
render-on-change scheduler (`renderScheduler.ts`), spring-damped rotation and framing
(`deviceMotion.ts`, `deviceFraming.ts`), view snapping (`deviceViewSnap.ts`), press-on-screen to
touch and press-off-screen to orbit (`phoneInteraction.ts`,
`apps/web/src/components/device/DevicePhoneViewport.tsx`, `mountDeviceViewer.ts`) and trackpad
orbit and pinch (`apps/web/src/components/device/phoneTrackpad.ts`), in
`apps/web/src/components/device/scene3d/` and `DeviceView3D.tsx`.

### MIT License

Copyright (c) 2026 T3 Tools Inc.
Copyright (c) 2026 Emanuele Di Pietro

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

## EvanBacon/serve-sim

Portions of Ryco's iOS simulator helper were adapted from
[`EvanBacon/serve-sim`](https://github.com/EvanBacon/serve-sim) at commit
`e9cae23a937670038c0ec3d1dd63d69d32e812db`. The upstream project is Copyright 2026 Evan Bacon and
is licensed under the Apache License, Version 2.0, reproduced below.

- `apps/server/native/device-helper/Sources/Orientation.swift` adapts `sendOrientation` from
  `packages/serve-sim/Sources/SimNative/HIDInjector.swift`: the GraphicsServices orientation
  event sent to the guest's `PurpleWorkspacePort`. Ryco changed the orientation names, the error
  reporting and the port-right handling.
- `apps/server/native/device-helper/Sources/FrameStream.swift` adopts serve-sim's low-latency
  encoder specification (`H264Encoder.swift`) and its bitrate scaling (`StreamBitrate.swift`,
  0.1 bits per pixel between 6 and 30 Mbps) for Ryco's own H.264 capture.
- `apps/server/native/device-helper/Sources/SimSettings.c` follows
  `packages/serve-sim/Sources/SimAXSettings/sim-ax-settings.m`: a tool run inside the simulator
  through `simctl spawn` that calls libAccessibility's `_AXS*` setters, MediaAccessibility's
  display-filter preferences and UIKit's `UIViewGlassLegibilitySetting` to read and change Reduce
  Motion, Reduce Transparency, Button Shapes, VoiceOver, color filters and Liquid Glass. Ryco's
  version resolves every symbol at run time and reports a missing one as unsupported, prints its
  status after a change, and is built from source by the helper's `build.sh`; no serve-sim binary
  is used.

### Apache License 2.0

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2026 Evan Bacon

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## Genymobile/scrcpy

Ryco's Android emulator video and input use the unmodified `scrcpy-server` jar from
[`Genymobile/scrcpy`](https://github.com/Genymobile/scrcpy) release v5.0.1. Ryco does not
redistribute it: the server downloads the release asset on first use, verifies its SHA-256
(`apps/server/src/device/android/scrcpyServer.ts`) and caches it under the Ryco home. The client
side of scrcpy's wire protocol in `apps/server/src/device/android/scrcpyProtocol.ts` follows the
upstream protocol documentation (`doc/develop.md`) and `ControlMessageReader.java` at that tag.
scrcpy is Copyright (C) 2018 Genymobile and Copyright (C) 2018-2026 Romain Vimont, and is
licensed under the Apache License, Version 2.0. The license text is reproduced under
EvanBacon/serve-sim above.
