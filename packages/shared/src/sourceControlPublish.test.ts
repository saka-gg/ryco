import type { SourceControlProviderDiscoveryItem } from "@ryco/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  getPublishProviderReadiness,
  isPublishRepositoryPathComplete,
  publishAccountsByProvider,
  publishProviderOption,
} from "./sourceControlPublish.ts";

function provider(
  overrides: Omit<Partial<SourceControlProviderDiscoveryItem>, "auth"> & {
    readonly auth?: Partial<SourceControlProviderDiscoveryItem["auth"]>;
  },
): SourceControlProviderDiscoveryItem {
  return {
    kind: "github",
    label: "GitHub",
    status: "available",
    installHint: "Install gh",
    ...overrides,
    auth: {
      status: "authenticated",
      account: Option.some("octo"),
      detail: Option.none(),
      ...overrides.auth,
    },
  } as unknown as SourceControlProviderDiscoveryItem;
}

describe("sourceControlPublish", () => {
  it("is ready only for an installed, signed-in host", () => {
    expect(
      getPublishProviderReadiness({ provider: "github", sourceControlProviders: [provider({})] }),
    ).toEqual({ ready: true, hint: null });
    expect(
      getPublishProviderReadiness({ provider: "gitlab", sourceControlProviders: [provider({})] })
        .ready,
    ).toBe(false);
    expect(
      getPublishProviderReadiness({
        provider: "github",
        sourceControlProviders: [provider({ status: "not_installed" as never })],
      }),
    ).toEqual({ ready: false, hint: "Install gh" });
    expect(
      getPublishProviderReadiness({
        provider: "github",
        sourceControlProviders: [provider({ auth: { status: "unauthenticated" } })],
      }).hint,
    ).toContain("not authenticated");
  });

  it("prefills the signed-in account per host", () => {
    expect(publishAccountsByProvider([provider({})]).github).toBe("octo");
    expect(publishAccountsByProvider([provider({})]).gitlab).toBeNull();
  });

  it("wants an owner and a name", () => {
    expect(isPublishRepositoryPathComplete("octo/app")).toBe(true);
    expect(isPublishRepositoryPathComplete("group/sub/app")).toBe(true);
    expect(isPublishRepositoryPathComplete("octo/")).toBe(false);
    expect(isPublishRepositoryPathComplete("app")).toBe(false);
  });

  it("falls back to GitHub for an unknown host", () => {
    expect(publishProviderOption("bitbucket").host).toBe("bitbucket.org");
  });
});
