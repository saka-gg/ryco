import { describe, expect, it } from "vite-plus/test";

import {
  buildCliProxyHubEntry,
  makeCliProxyHubId,
  savedKeyApplies,
  savedCloudflareSecretApplies,
  validateCliProxyHubDraft,
} from "./cliProxyHubs.logic";

describe("validateCliProxyHubDraft", () => {
  it("requires an http(s) URL and a key unless one is saved", () => {
    const draft = { url: "http://127.0.0.1:8317", label: "", managementKey: "" };
    expect(validateCliProxyHubDraft(draft, { hasSavedKey: false })).toBe(
      "Enter the hub's management key.",
    );
    expect(validateCliProxyHubDraft(draft, { hasSavedKey: true })).toBeNull();
    expect(
      validateCliProxyHubDraft({ ...draft, url: "ftp://hub" }, { hasSavedKey: true }),
    ).toContain("hub URL");
  });

  it("refuses a URL with a user name or password, as the node does", () => {
    const draft = { url: "https://admin:pass@hub.example.com", label: "", managementKey: "k" };
    expect(validateCliProxyHubDraft(draft, { hasSavedKey: false })).toContain(
      "Remove the user name and password",
    );
    expect(
      validateCliProxyHubDraft(
        { ...draft, url: "https://admin@hub.example.com" },
        { hasSavedKey: false },
      ),
    ).toContain("Remove the user name and password");
  });
});

describe("Cloudflare Access hub drafts", () => {
  const existing = {
    url: "https://hub.example",
    enabled: true,
    managementKey: "",
    managementKeyRedacted: true,
    cloudflareAccessClientId: "token.access",
    cloudflareAccessClientSecret: "",
    cloudflareAccessClientSecretRedacted: true,
  };
  const draft = {
    url: existing.url,
    label: "",
    managementKey: "",
    cloudflareAccessClientId: "token.access",
    cloudflareAccessClientSecret: "",
  };

  it("retains a saved secret only at the same address and Client ID", () => {
    expect(savedCloudflareSecretApplies(draft, existing)).toBe(true);
    expect(buildCliProxyHubEntry(draft, existing)).toMatchObject({
      cloudflareAccessClientSecret: "",
      cloudflareAccessClientSecretRedacted: true,
    });
    for (const changed of [
      { ...draft, url: "https://other.example", managementKey: "key" },
      { ...draft, cloudflareAccessClientId: "new.access" },
    ]) {
      expect(savedCloudflareSecretApplies(changed, existing)).toBe(false);
      expect(
        validateCliProxyHubDraft(changed, {
          hasSavedKey: true,
          hasSavedCloudflareSecret: savedCloudflareSecretApplies(changed, existing),
        }),
      ).toContain("Enter both");
      expect(
        buildCliProxyHubEntry(changed, existing).cloudflareAccessClientSecretRedacted,
      ).toBeUndefined();
    }
  });

  it("requires a pair, replaces an entered secret and removes a cleared token", () => {
    expect(validateCliProxyHubDraft(draft, { hasSavedKey: true })).toContain("Enter both");
    expect(
      validateCliProxyHubDraft(draft, { hasSavedKey: true, hasSavedCloudflareSecret: true }),
    ).toBeNull();
    expect(
      buildCliProxyHubEntry({ ...draft, cloudflareAccessClientSecret: " new-secret " }, existing),
    ).toMatchObject({
      cloudflareAccessClientSecret: "new-secret",
    });
    const cleared = { ...draft, cloudflareAccessClientId: "" };
    expect(savedCloudflareSecretApplies(cleared, existing)).toBe(false);
    expect(validateCliProxyHubDraft(cleared, { hasSavedKey: true })).toBeNull();
    expect(
      buildCliProxyHubEntry(cleared, existing).cloudflareAccessClientSecretRedacted,
    ).toBeUndefined();
  });
});

describe("makeCliProxyHubId", () => {
  it("derives a unique slug from the host", () => {
    expect(makeCliProxyHubId("http://127.0.0.1:8317", [])).toBe("cliproxy-127-0-0-1-8317");
    expect(makeCliProxyHubId("https://Hub.example.ts.net", ["cliproxy-hub-example-ts-net"])).toBe(
      "cliproxy-hub-example-ts-net-2",
    );
    expect(makeCliProxyHubId("not a url", [])).toBe("cliproxy-hub");
  });
});

describe("buildCliProxyHubEntry", () => {
  const saved = {
    url: "http://old:8317",
    managementKey: "",
    managementKeyRedacted: true,
    enabled: false,
  };

  it("keeps a saved key when the key field is left empty and the address is unchanged", () => {
    expect(
      buildCliProxyHubEntry(
        { url: " http://old:8317/v0/management ", label: " Home ", managementKey: "" },
        saved,
      ),
    ).toEqual({
      url: "http://old:8317/v0/management",
      label: "Home",
      managementKey: "",
      managementKeyRedacted: true,
      enabled: false,
    });
  });

  it("never carries a saved key to a different address", () => {
    expect(savedKeyApplies("http://new:8317", saved)).toBe(false);
    expect(savedKeyApplies("https://old:8317", saved)).toBe(false);
    expect(savedKeyApplies("http://old:8317/proxy", saved)).toBe(true);
    expect(
      buildCliProxyHubEntry({ url: "http://new:8317", label: "", managementKey: "" }, saved),
    ).toEqual({ url: "http://new:8317", managementKey: "", enabled: false });
    expect(
      validateCliProxyHubDraft(
        { url: "http://new:8317", label: "", managementKey: "" },
        { hasSavedKey: savedKeyApplies("http://new:8317", saved) },
      ),
    ).toBe("Enter the hub's management key.");
  });

  it("replaces the key when a new one is entered", () => {
    expect(
      buildCliProxyHubEntry({ url: "http://new:8317", label: "", managementKey: " k2 " }, saved),
    ).toEqual({ url: "http://new:8317", managementKey: "k2", enabled: false });
    expect(
      buildCliProxyHubEntry({ url: "http://new:8317", label: "", managementKey: "k" }, undefined),
    ).toEqual({ url: "http://new:8317", managementKey: "k", enabled: true });
  });
});
