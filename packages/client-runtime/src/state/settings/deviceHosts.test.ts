import { describe, expect, it } from "vite-plus/test";

import { EMPTY_DRAFT, hostFromDraft, toDraft } from "./deviceHosts.ts";

describe("SSH host editor fields", () => {
  it("builds a host, naming it after its destination when no name is given", () => {
    expect(hostFromDraft({ ...EMPTY_DRAFT, target: "me@studio.local", port: "2222" })).toEqual({
      name: "me@studio.local",
      target: "me@studio.local",
      port: 2222,
      executable: "/opt/homebrew/bin/ryco",
    });
  });

  it("explains what is missing or invalid", () => {
    expect(hostFromDraft(EMPTY_DRAFT)).toMatch(/destination/);
    expect(hostFromDraft({ ...EMPTY_DRAFT, target: "me@host; rm" })).toMatch(/alias/);
    expect(hostFromDraft({ ...EMPTY_DRAFT, target: "mac", port: "70000" })).toMatch(/port/);
    expect(hostFromDraft({ ...EMPTY_DRAFT, target: "mac", executable: "ryco" })).toMatch(
      /absolute/,
    );
    expect(hostFromDraft({ ...EMPTY_DRAFT, target: "mac", identityFile: "id_rsa" })).toMatch(
      /key file/,
    );
  });

  it("round-trips a saved host", () => {
    const host = { name: "Mac", target: "mac", identityFile: "/k", executable: "/bin/ryco" };
    expect(hostFromDraft(toDraft(host))).toEqual(host);
  });
});
