import { describe, expect, it } from "@effect/vitest";

import {
  azureRemoteRepositoryKey,
  changeRequestNumberFromUrl,
  changeRequestRepositoryKey,
} from "./changeRequestRepositoryKey.ts";

// The cases live with the helpers in packages/shared/src/git.changeRequestUrl.test.ts.
describe("changeRequestRepositoryKey re-export", () => {
  it("resolves the shared helpers", () => {
    expect(changeRequestRepositoryKey("https://github.com/Acme/Repo/pull/5")).toBe(
      "github.com/acme/repo",
    );
    expect(azureRemoteRepositoryKey("git@ssh.dev.azure.com:v3/acme/Shop/shop")).toBe(
      "azure:acme/shop/shop",
    );
    expect(changeRequestNumberFromUrl("https://github.com/Acme/Repo/pull/5/files")).toBe(5);
  });
});
