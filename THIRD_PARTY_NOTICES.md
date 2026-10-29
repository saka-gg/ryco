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
