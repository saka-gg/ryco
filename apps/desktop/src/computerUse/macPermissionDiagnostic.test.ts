import { expect, it, vi } from "vitest";
import { createMacPermissionDiagnostic } from "./macPermissionDiagnostic.ts";

it("checks the app and helper once, including concurrent refreshes", async () => {
  const verify = vi.fn(async () => {});
  const diagnose = createMacPermissionDiagnostic("/Ryco.app", "/Ryco.app/helper", verify);
  expect(await Promise.all([diagnose(), diagnose(), diagnose()])).toEqual([null, null, null]);
  expect(verify.mock.calls).toEqual([["/Ryco.app"], ["/Ryco.app/helper"]]);
});
it.each(["/Ryco.app", "/Ryco.app/helper"])(
  "explains invalid code identity at %s",
  async (invalid) => {
    const diagnose = createMacPermissionDiagnostic(
      "/Ryco.app",
      "/Ryco.app/helper",
      async (path) => {
        if (path === invalid) throw Object.assign(new Error("invalid signature"), { code: 1 });
      },
    );
    expect(await diagnose()).toContain("invalid macOS code signature");
  },
);
it("does not mistake a timeout or missing verifier for an invalid signature", async () => {
  for (const failure of [{ code: "ENOENT" }, { code: 1, killed: true }]) {
    const diagnose = createMacPermissionDiagnostic("/Ryco.app", "/helper", async () => {
      throw failure;
    });
    expect(await diagnose()).toBeNull();
  }
});
