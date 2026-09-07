# Upstream provenance

Vendored from https://github.com/Porabuild/Poracode/tree/4c3a1436843b8ab92a364cf0d9cffdf99ca0f5da/native/computer-use-helper on 2026-09-07.

Copyright belongs to the upstream contributors. The Apache-2.0 license is included in LICENSE. This native component retains its upstream crate/binary names and protocol. Ryco supplies its own policy, lifecycle, app presentation and provider integration. Local integration changes must be recorded here.

## Ryco integration changes

- Corrected the ANSI shift-modifier unit test to exercise the ANSI fallback explicitly. The original test used the host's active keyboard layout and incorrectly required US punctuation modifier rules on non-US keyboards. Runtime behavior is unchanged.
