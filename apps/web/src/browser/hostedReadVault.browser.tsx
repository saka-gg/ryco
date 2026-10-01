import { describe, expect, it } from "vitest";
import { createHostedReadVault } from "../persistence/hostedReadVault";

describe("remembered browser encrypted storage", () => {
  const create = (name = `read-cache-test-${crypto.randomUUID()}`) =>
    createHostedReadVault(indexedDB, crypto, location.origin, name);
  it("survives a new vault instance with a non-exportable local key", async () => {
    const name = `read-cache-test-${crypto.randomUUID()}`;
    const vault = create(name);
    const owner = (await vault.account("account-a", true))!;
    expect(owner.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", owner.key)).rejects.toThrow();
    await vault.write(owner, "env-a", { text: "Saved conversation", draft: "unsent" });
    const reopened = create(name);
    const remembered = (await reopened.account("account-a", false))!;
    expect(remembered.epoch).toBe(owner.epoch);
    expect(await reopened.read(remembered, "env-a")).toEqual({
      text: "Saved conversation",
      draft: "unsent",
    });
    const foreignOrigin = createHostedReadVault(
      indexedDB,
      crypto,
      "https://different.example.test",
      name,
    );
    expect(await foreignOrigin.read(remembered, "env-a")).toBeNull();
    await vault.purge(owner.id);
  });
  it("fences late writes after logout, including when the same account signs in again", async () => {
    const vault = create();
    const old = (await vault.account("same-account", true))!;
    await vault.write(old, "thread", { text: "old" });
    await vault.purge(old.id);
    const fresh = (await vault.account(old.id, true))!;
    expect(fresh.epoch).not.toBe(old.epoch);
    await vault.write(old, "thread", { text: "late stale write" });
    expect(await vault.read(fresh, "thread")).toBeNull();
    expect(await vault.read(old, "thread")).toBeNull();
    await vault.purge(fresh.id);
  });
  it("isolates accounts and serializes simultaneous key creation across tabs", async () => {
    const name = `read-cache-test-${crypto.randomUUID()}`;
    const vault = create(name);
    const otherTab = create(name);
    const [first, second] = await Promise.all([
      vault.account("a", true),
      otherTab.account("a", true),
    ]);
    expect(first!.epoch).toBe(second!.epoch);
    const other = (await vault.account("b", true))!;
    await vault.write(first!, "same-thread", { text: "A" });
    await otherTab.write(other, "same-thread", { text: "B" });
    await vault.purge("a");
    expect(await otherTab.read(second!, "same-thread")).toBeNull();
    expect(await vault.read(other, "same-thread")).toEqual({ text: "B" });
    await vault.purge("b");
  });
  it("bounds retained records and rejects oversized payloads", async () => {
    const vault = create();
    const owner = (await vault.account("bounded", true))!;
    for (let i = 0; i < 70; i++) await vault.write(owner, `thread-${i}`, { text: `${i}` });
    expect(await vault.read(owner, "thread-0")).toBeNull();
    expect(await vault.read(owner, "thread-69")).toEqual({ text: "69" });
    await vault.write(owner, "large", "x".repeat(2 * 1024 * 1024));
    expect(await vault.read(owner, "large")).toBeNull();
    await vault.purge(owner.id);
  });
});
