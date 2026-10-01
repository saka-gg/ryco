/** Page-owned encrypted storage. The service worker never sees these records or keys. */
export interface ReadVaultAccount {
  readonly id: string;
  readonly epoch: string;
  readonly key: CryptoKey;
}
interface SealedRecord {
  readonly id: string;
  readonly accountId: string;
  readonly epoch: string;
  readonly name: string;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: ArrayBuffer;
  readonly updatedAt: number;
}
export const READ_VAULT_MAX_BYTES = 12 * 1024 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 64;
const request = <T>(operation: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    operation.addEventListener("success", () => resolve(operation.result), { once: true });
    operation.addEventListener("error", () => reject(operation.error), { once: true });
  });
const complete = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve(), { once: true });
    const fail = () => reject(tx.error ?? new Error("Read cache transaction failed."));
    tx.addEventListener("abort", fail, { once: true });
    tx.addEventListener("error", fail, { once: true });
  });

export function createHostedReadVault(
  factory: IDBFactory,
  crypto: Crypto,
  origin: string,
  name = "ryco-hosted-read-v1",
) {
  let database: Promise<IDBDatabase> | undefined;
  const open = () =>
    (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const operation = factory.open(name, 1);
      operation.addEventListener(
        "upgradeneeded",
        () => {
          operation.result.createObjectStore("accounts", { keyPath: "id" });
          const records = operation.result.createObjectStore("records", { keyPath: "id" });
          records.createIndex("accountId", "accountId");
        },
        { once: true },
      );
      operation.addEventListener(
        "success",
        () => {
          operation.result.addEventListener("versionchange", () => operation.result.close(), {
            once: true,
          });
          resolve(operation.result);
        },
        { once: true },
      );
      operation.addEventListener("error", () => reject(operation.error), { once: true });
      operation.addEventListener("blocked", () => reject(new Error("Read cache is unavailable.")), {
        once: true,
      });
    }));
  const idFor = (accountId: string, record: string) => JSON.stringify([accountId, record]);
  const aad = (account: ReadVaultAccount, record: string) =>
    new TextEncoder().encode(JSON.stringify([1, origin, account.id, account.epoch, record]));
  return {
    async account(id: string, create: boolean): Promise<ReadVaultAccount | null> {
      const db = await open();
      const existing = (await request(
        db.transaction("accounts").objectStore("accounts").get(id),
      )) as ReadVaultAccount | undefined;
      if (existing || !create) return existing ?? null;
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const candidate: ReadVaultAccount = { id, epoch: crypto.randomUUID(), key };
      const tx = db.transaction("accounts", "readwrite");
      const done = complete(tx);
      const store = tx.objectStore("accounts");
      const winner = (await request(store.get(id))) as ReadVaultAccount | undefined;
      if (!winner) store.put(candidate);
      await done;
      return winner ?? candidate;
    },
    async read(account: ReadVaultAccount, record: string): Promise<unknown | null> {
      const db = await open();
      const tx = db.transaction(["accounts", "records"]);
      const [current, sealed] = await Promise.all([
        request(tx.objectStore("accounts").get(account.id)) as Promise<
          ReadVaultAccount | undefined
        >,
        request(tx.objectStore("records").get(idFor(account.id, record))) as Promise<
          SealedRecord | undefined
        >,
      ]);
      if (
        current?.epoch !== account.epoch ||
        !sealed ||
        sealed.epoch !== account.epoch ||
        sealed.data.byteLength > MAX_RECORD_BYTES + 16
      )
        return null;
      try {
        const bytes = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: sealed.iv, additionalData: aad(account, record) },
          account.key,
          sealed.data,
        );
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        return null;
      }
    },
    async write(account: ReadVaultAccount, record: string, value: unknown): Promise<void> {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      if (bytes.byteLength > MAX_RECORD_BYTES) return;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(account, record) },
        account.key,
        bytes,
      );
      const db = await open();
      const tx = db.transaction(["accounts", "records"], "readwrite");
      const done = complete(tx);
      const current = (await request(tx.objectStore("accounts").get(account.id))) as
        | ReadVaultAccount
        | undefined;
      // Purging an account is a durable fence, including for writes from another tab.
      if (current?.epoch === account.epoch) {
        const store = tx.objectStore("records");
        const records = (await request(store.getAll())) as SealedRecord[];
        const id = idFor(account.id, record);
        const others = records
          .filter((entry) => entry.id !== id)
          .toSorted((a, b) => a.updatedAt - b.updatedAt);
        let size = others.reduce((total, entry) => total + entry.data.byteLength, data.byteLength);
        while (others.length >= MAX_RECORDS || size > READ_VAULT_MAX_BYTES) {
          const oldest = others.shift();
          if (!oldest) break;
          size -= oldest.data.byteLength;
          store.delete(oldest.id);
        }
        store.put({
          id,
          accountId: account.id,
          epoch: account.epoch,
          name: record,
          iv,
          data,
          updatedAt: Date.now(),
        } satisfies SealedRecord);
      }
      await done;
    },
    async remove(account: ReadVaultAccount, record: string): Promise<void> {
      const db = await open();
      const tx = db.transaction(["accounts", "records"], "readwrite");
      const done = complete(tx);
      const current = (await request(tx.objectStore("accounts").get(account.id))) as
        | ReadVaultAccount
        | undefined;
      if (current?.epoch === account.epoch)
        tx.objectStore("records").delete(idFor(account.id, record));
      await done;
    },
    async purge(accountId: string): Promise<void> {
      const db = await open();
      const tx = db.transaction(["accounts", "records"], "readwrite");
      const done = complete(tx);
      tx.objectStore("accounts").delete(accountId);
      const store = tx.objectStore("records");
      const ids = await request(store.index("accountId").getAllKeys(accountId));
      for (const id of ids) store.delete(id);
      await done;
    },
  };
}

let browserVault: ReturnType<typeof createHostedReadVault> | undefined;
export function getHostedReadVault() {
  return (browserVault ??= createHostedReadVault(
    window.indexedDB,
    window.crypto,
    window.location.origin,
  ));
}
