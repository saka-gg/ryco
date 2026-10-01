import { EnvironmentId } from "@ryco/contracts";
import {
  reconcileWorkspaceMachine,
  type WorkspaceMachineCatalogInput,
} from "@ryco/client-runtime/state/workspace";
import { describe, expect, it } from "vite-plus/test";
import { hostedComposerExecutionTargets } from "./ExecutionTarget.logic";

const source = EnvironmentId.make("source");
function machine(label: string, overrides: Partial<WorkspaceMachineCatalogInput> = {}) {
  return reconcileWorkspaceMachine({
    environmentId: EnvironmentId.make(label),
    label,
    clientTier: "hosted-web",
    nativeTrust: "unknown",
    requiresNativeVerification: false,
    effectiveRole: "owner",
    online: true,
    observedAt: 1,
    lastSeenAt: 1,
    connectionState: "disconnected",
    ...overrides,
  });
}
const targets = (machines: ReturnType<typeof machine>[], ready = true) =>
  hostedComposerExecutionTargets({ machines, ready, environmentId: source, label: "Source" });

describe("hosted composer devices", () => {
  it("includes online devices without an active relay or loaded project", () => {
    expect(targets([machine("Second Mac"), machine("Source", { environmentId: source })])).toEqual([
      { environmentId: source, label: "Source", disabled: false, status: "Online" },
      { environmentId: "Second Mac", label: "Second Mac", disabled: false, status: "Online" },
    ]);
  });

  it("keeps access restrictions visible and excludes removed or revoked devices", () => {
    const list = targets([
      machine("Offline", { online: false }),
      machine("Viewer", { effectiveRole: "viewer" }),
      machine("Native", { capabilities: { nativeClientRequired: true } }),
      machine("Revoked", { revokedAt: 1 }),
      machine("Removed", { removed: true }),
    ]);
    expect(list.map((target) => [target.label, target.disabled, target.status])).toEqual([
      ["Source", true, "Unavailable"],
      ["Native", true, "Use the native app"],
      ["Offline", true, "Offline"],
      ["Viewer", true, "Read only"],
    ]);
  });

  it("disables cached directory entries while authorization is refreshing", () => {
    expect(
      targets([machine("Source", { environmentId: source }), machine("Second")], false),
    ).toEqual([
      { environmentId: source, label: "Source", disabled: true, status: "Refreshing devices…" },
      { environmentId: "Second", label: "Second", disabled: true, status: "Refreshing devices…" },
    ]);
  });
});
