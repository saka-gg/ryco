import { describe, expect, it } from "vite-plus/test";

import { errorMessageOr } from "./errorMessage";
import { firstRouteParam } from "./routeParams";

describe("route params and error messages", () => {
  it("reads the first non-blank param", () => {
    expect(firstRouteParam(["a", "b"])).toBe("a");
    expect(firstRouteParam(" x ")).toBe("x");
    expect(firstRouteParam(42)).toBe("42");
    expect(firstRouteParam("  ")).toBeNull();
    expect(firstRouteParam(undefined)).toBeNull();
  });

  it("keeps an error's own words, else the fallback", () => {
    expect(errorMessageOr(new Error("disk full"), "x")).toBe("disk full");
    expect(errorMessageOr({ _tag: "NotesError", message: "conflict" }, "x")).toBe("conflict");
    expect(errorMessageOr(new Error("  "), "fallback")).toBe("fallback");
    expect(errorMessageOr("boom", "fallback")).toBe("fallback");
  });
});
