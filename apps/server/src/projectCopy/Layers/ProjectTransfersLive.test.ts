import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_MAX_ARTIFACT_BYTES,
  PROJECT_COPY_MAX_AVATAR_BYTES,
  type ProjectImportId,
  type ProjectTransferId,
  type ProjectTransferPurpose,
} from "@ryco/contracts/project-copy";
import { it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";

import { PROJECT_IMPORTS_DIRECTORY, PROJECT_TRANSFERS_DIRECTORY } from "../projectCopyStartup.ts";
import type { ProjectTransfersShape } from "../Services/ProjectTransfers.ts";
import { type ProjectTransfersOptions, makeProjectTransfers } from "./ProjectTransfersLive.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const newTransferId = () => randomUUID() as ProjectTransferId;
const newImportId = () => randomUUID() as ProjectImportId;
const makeStateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ryco-transfers-"));
const transfersDir = (stateDir: string) => path.join(stateDir, PROJECT_TRANSFERS_DIRECTORY);
const importsDir = (stateDir: string) => path.join(stateDir, PROJECT_IMPORTS_DIRECTORY);
const listTransfers = (stateDir: string) => fs.readdirSync(transfersDir(stateDir)).toSorted();

/** One store over `stateDir`, living as long as the calling scope: a new one is a restart. */
const openStore = (stateDir: string, options?: Omit<ProjectTransfersOptions, "stateDir">) =>
  makeProjectTransfers({ stateDir, ...options }).pipe(Effect.provide(NodeServices.layer));

const chunk = (bytes: Uint8Array, offset: number, length = PROJECT_COPY_CHUNK_BYTES) =>
  Buffer.from(bytes.subarray(offset, offset + length)).toString("base64");

const beginFor = (
  transfers: ProjectTransfersShape,
  transferId: ProjectTransferId,
  bytes: Uint8Array,
  purpose: ProjectTransferPurpose = "commits-bundle",
) => transfers.begin({ transferId, purpose, byteLength: bytes.byteLength, sha256: sha256(bytes) });

const appendAll = Effect.fn("appendAll")(function* (
  transfers: ProjectTransfersShape,
  transferId: ProjectTransferId,
  bytes: Uint8Array,
  from = 0,
  chunkBytes = PROJECT_COPY_CHUNK_BYTES,
) {
  let receivedBytes = from;
  for (let offset = from; offset < bytes.byteLength; offset += chunkBytes) {
    const progress = yield* transfers.append({
      transferId,
      offset,
      dataBase64: chunk(bytes, offset, chunkBytes),
    });
    receivedBytes = progress.receivedBytes;
  }
  return receivedBytes;
});

/** A committed transfer of `bytes`. */
const uploadCommitted = Effect.fn("uploadCommitted")(function* (
  transfers: ProjectTransfersShape,
  bytes: Uint8Array,
  purpose: ProjectTransferPurpose = "commits-bundle",
) {
  const transferId = newTransferId();
  yield* beginFor(transfers, transferId, bytes, purpose);
  yield* appendAll(transfers, transferId, bytes);
  yield* transfers.commit({ transferId });
  return transferId;
});

describe("ProjectTransfersLive", () => {
  it.effect("uploads, commits and claims a transfer into the import's directory", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const transfers = yield* openStore(stateDir);
      const bytes = randomBytes(PROJECT_COPY_CHUNK_BYTES * 2 + 1234);
      const transferId = newTransferId();

      expect(yield* beginFor(transfers, transferId, bytes)).toEqual({
        transferId,
        receivedBytes: 0,
      });
      expect(yield* appendAll(transfers, transferId, bytes)).toBe(bytes.byteLength);
      expect(yield* transfers.commit({ transferId })).toEqual({
        transferId,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      });
      const sidecar = JSON.parse(
        fs.readFileSync(path.join(transfersDir(stateDir), `${transferId}.json`), "utf8"),
      );
      expect(sidecar).toMatchObject({
        purpose: "commits-bundle",
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      });
      expect(typeof sidecar.createdAt).toBe("string");
      expect(typeof sidecar.lastAppendAt).toBe("string");

      const importId = newImportId();
      const [claimed] = yield* transfers.claimForImport({
        importId,
        transfers: [{ transferId, purpose: "commits-bundle" }],
      });
      expect(claimed).toEqual({
        transferId,
        purpose: "commits-bundle",
        path: path.join(importsDir(stateDir), importId, `${transferId}.commits-bundle`),
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      });
      expect(Buffer.compare(fs.readFileSync(claimed!.path), bytes)).toBe(0);
      expect(listTransfers(stateDir)).toEqual([]);

      yield* transfers.releaseImport(importId);
      expect(fs.existsSync(path.join(importsDir(stateDir), importId))).toBe(false);
    }),
  );

  it.effect("keeps begin idempotent for the same transfer and refuses a different one", () =>
    Effect.gen(function* () {
      const transfers = yield* openStore(makeStateDir());
      const bytes = randomBytes(5000);
      const transferId = newTransferId();
      yield* beginFor(transfers, transferId, bytes);
      yield* transfers.append({ transferId, offset: 0, dataBase64: chunk(bytes, 0, 2000) });

      expect(yield* beginFor(transfers, transferId, bytes)).toEqual({
        transferId,
        receivedBytes: 2000,
      });
      for (const changed of [
        { purpose: "changes-patch" as const, byteLength: bytes.byteLength, sha256: sha256(bytes) },
        { purpose: "commits-bundle" as const, byteLength: 4999, sha256: sha256(bytes) },
        { purpose: "commits-bundle" as const, byteLength: 5000, sha256: sha256(randomBytes(9)) },
      ]) {
        const error = yield* Effect.flip(transfers.begin({ transferId, ...changed }));
        expect(error.code).toBe("conflict");
      }
    }),
  );

  it.effect("resumes an upload, a commit and a claim after a restart", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const bytes = randomBytes(PROJECT_COPY_CHUNK_BYTES * 3);
      const transferId = newTransferId();
      const importId = newImportId();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const transfers = yield* openStore(stateDir);
          yield* beginFor(transfers, transferId, bytes);
          yield* transfers.append({ transferId, offset: 0, dataBase64: chunk(bytes, 0) });
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const transfers = yield* openStore(stateDir);
          const resumed = yield* beginFor(transfers, transferId, bytes);
          expect(resumed.receivedBytes).toBe(PROJECT_COPY_CHUNK_BYTES);
          yield* appendAll(transfers, transferId, bytes, resumed.receivedBytes);
          yield* transfers.commit({ transferId });
        }),
      );

      const claimedPath = yield* Effect.scoped(
        Effect.gen(function* () {
          const transfers = yield* openStore(stateDir);
          expect((yield* beginFor(transfers, transferId, bytes)).receivedBytes).toBe(
            bytes.byteLength,
          );
          const [claimed] = yield* transfers.claimForImport({
            importId,
            transfers: [{ transferId, purpose: "commits-bundle" }],
          });
          return claimed!.path;
        }),
      );
      expect(Buffer.compare(fs.readFileSync(claimedPath), bytes)).toBe(0);

      const transfers = yield* openStore(stateDir);
      const [again] = yield* transfers.claimForImport({
        importId,
        transfers: [{ transferId, purpose: "commits-bundle" }],
      });
      expect(again!.path).toBe(claimedPath);
      const stolen = yield* Effect.flip(
        transfers.claimForImport({
          importId: newImportId(),
          transfers: [{ transferId, purpose: "commits-bundle" }],
        }),
      );
      expect(stolen.code).toBe("conflict");
    }),
  );

  it.effect("never takes opted-in ignored files over a relay the Hub can read (A33)", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const bytes = randomBytes(PROJECT_COPY_CHUNK_BYTES + 1234);
      const sensitive = (transferId: ProjectTransferId, carriesIgnoredFiles = true) => ({
        transferId,
        purpose: "changes-patch" as const,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        carriesIgnoredFiles,
      });
      const transferId = newTransferId();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const transfers = yield* openStore(stateDir);
          // Refused before anything exists on disk.
          const refused = newTransferId();
          const denied = yield* Effect.flip(transfers.begin(sensitive(refused), "unencrypted"));
          expect(denied.code).toBe("access-denied");
          expect(listTransfers(stateDir)).toEqual([]);

          yield* transfers.begin(sensitive(transferId), "encrypted");
          yield* transfers.append(
            { transferId, offset: 0, dataBase64: chunk(bytes, 0) },
            "encrypted",
          );
        }),
      );

      // After a restart, a channel that fell back to plaintext still cannot carry the rest.
      const transfers = yield* openStore(stateDir);
      const rest = {
        transferId,
        offset: PROJECT_COPY_CHUNK_BYTES,
        dataBase64: chunk(bytes, PROJECT_COPY_CHUNK_BYTES),
      };
      expect((yield* Effect.flip(transfers.append(rest, "unencrypted"))).code).toBe(
        "access-denied",
      );
      expect((yield* Effect.flip(transfers.begin(sensitive(transferId), "unencrypted"))).code).toBe(
        "access-denied",
      );
      // Its declaration is part of the begin: it cannot be taken back under the same id.
      expect(
        (yield* Effect.flip(transfers.begin(sensitive(transferId, false), "unencrypted"))).code,
      ).toBe("conflict");
      expect((yield* transfers.append(rest, "encrypted")).receivedBytes).toBe(bytes.byteLength);
      yield* transfers.commit({ transferId });

      // Bytes without ignored files travel over any channel; calls from the node itself declare none.
      const plain = newTransferId();
      yield* transfers.begin(sensitive(plain, false), "unencrypted");
      yield* transfers.append(
        { transferId: plain, offset: 0, dataBase64: chunk(bytes, 0) },
        "unencrypted",
      );
      const internal = newTransferId();
      yield* transfers.begin(sensitive(internal));
      yield* transfers.append({ transferId: internal, offset: 0, dataBase64: chunk(bytes, 0) });
    }),
  );

  it.effect("appends only at receivedBytes and treats rewritten ranges by their bytes", () =>
    Effect.gen(function* () {
      const transfers = yield* openStore(makeStateDir());
      const bytes = randomBytes(3000);
      const transferId = newTransferId();
      yield* beginFor(transfers, transferId, bytes);
      yield* transfers.append({ transferId, offset: 0, dataBase64: chunk(bytes, 0, 1000) });

      const gap = yield* Effect.flip(
        transfers.append({ transferId, offset: 1500, dataBase64: chunk(bytes, 1500, 100) }),
      );
      expect(gap).toMatchObject({ code: "invalid", receivedBytes: 1000 });

      const replay = yield* transfers.append({
        transferId,
        offset: 200,
        dataBase64: chunk(bytes, 200, 300),
      });
      expect(replay.receivedBytes).toBe(1000);

      const rewritten = Buffer.from(bytes.subarray(0, 1000));
      rewritten[10] = (rewritten[10]! + 1) % 256;
      const conflict = yield* Effect.flip(
        transfers.append({ transferId, offset: 0, dataBase64: rewritten.toString("base64") }),
      );
      expect(conflict.code).toBe("conflict");

      // A chunk that starts inside the held bytes appends only what is new.
      const straddle = yield* transfers.append({
        transferId,
        offset: 900,
        dataBase64: chunk(bytes, 900, 1100),
      });
      expect(straddle.receivedBytes).toBe(2000);

      const pastEnd = yield* Effect.flip(
        transfers.append({ transferId, offset: 2000, dataBase64: chunk(randomBytes(1001), 0) }),
      );
      expect(pastEnd).toMatchObject({ code: "invalid", receivedBytes: 2000 });
      const empty = yield* Effect.flip(
        transfers.append({ transferId, offset: 2000, dataBase64: "==" }),
      );
      expect(empty.code).toBe("invalid");

      yield* appendAll(transfers, transferId, bytes, 2000);
      expect((yield* transfers.commit({ transferId })).sha256).toBe(sha256(bytes));
    }),
  );

  it.effect("serializes concurrent and duplicated appends to one transfer", () =>
    Effect.gen(function* () {
      const transfers = yield* openStore(makeStateDir());
      const chunkBytes = 1024;
      const bytes = randomBytes(chunkBytes * 48);
      const transferId = newTransferId();
      yield* beginFor(transfers, transferId, bytes);

      // Every chunk is sent twice at once, all chunks in parallel; a chunk ahead of the node's
      // bytes retries until the chunks before it landed.
      const sendChunk = (offset: number): Effect.Effect<void> =>
        transfers.append({ transferId, offset, dataBase64: chunk(bytes, offset, chunkBytes) }).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            error.receivedBytes !== undefined && error.receivedBytes < offset
              ? Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => sendChunk(offset))))
              : Effect.die(error),
          ),
        );
      const offsets = Array.from(
        { length: bytes.byteLength / chunkBytes },
        (_, i) => i * chunkBytes,
      );
      yield* Effect.forEach([...offsets, ...offsets], sendChunk, {
        concurrency: "unbounded",
        discard: true,
      });

      expect((yield* beginFor(transfers, transferId, bytes)).receivedBytes).toBe(bytes.byteLength);
      expect((yield* transfers.commit({ transferId })).sha256).toBe(sha256(bytes));
    }),
  );

  it.effect("lets one of two different chunks at the same offset win", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const transfers = yield* openStore(stateDir);
      const transferId = newTransferId();
      yield* transfers.begin({
        transferId,
        purpose: "changes-patch",
        byteLength: 4096,
        sha256: sha256(randomBytes(1)),
      });
      const candidates = [randomBytes(4096), randomBytes(4096)];
      const outcomes = yield* Effect.forEach(
        candidates,
        (candidate) =>
          transfers
            .append({ transferId, offset: 0, dataBase64: chunk(candidate, 0) })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );

      const winners = outcomes.flatMap((outcome, index) =>
        outcome._tag === "Success" ? [candidates[index]!] : [],
      );
      expect(winners).toHaveLength(1);
      const loser = outcomes.find((outcome) => outcome._tag === "Failure");
      expect(loser?._tag === "Failure" && loser.failure.code).toBe("conflict");
      const held = fs.readFileSync(path.join(transfersDir(stateDir), `${transferId}.part`));
      expect(Buffer.compare(held, winners[0]!)).toBe(0);
    }),
  );

  it.effect("commits only complete transfers with the declared sha-256", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const transfers = yield* openStore(stateDir);
      const bytes = randomBytes(4000);
      const transferId = newTransferId();
      yield* beginFor(transfers, transferId, bytes);
      yield* transfers.append({ transferId, offset: 0, dataBase64: chunk(bytes, 0, 1000) });
      const incomplete = yield* Effect.flip(transfers.commit({ transferId }));
      expect(incomplete).toMatchObject({ code: "invalid", receivedBytes: 1000 });

      // Declared with another digest: the bytes can never commit, so the upload starts over.
      const mismatched = newTransferId();
      yield* transfers.begin({
        transferId: mismatched,
        purpose: "changes-patch",
        byteLength: bytes.byteLength,
        sha256: sha256(randomBytes(4000)),
      });
      yield* appendAll(transfers, mismatched, bytes);
      const digest = yield* Effect.flip(transfers.commit({ transferId: mismatched }));
      expect(digest).toMatchObject({ code: "invalid", receivedBytes: 0 });
      expect(fs.statSync(path.join(transfersDir(stateDir), `${mismatched}.part`)).size).toBe(0);

      yield* appendAll(transfers, transferId, bytes, 1000);
      yield* transfers.commit({ transferId });
      expect(yield* transfers.commit({ transferId })).toMatchObject({ transferId });
      const late = yield* Effect.flip(
        transfers.append({ transferId, offset: 0, dataBase64: chunk(bytes, 0, 10) }),
      );
      expect(late.code).toBe("conflict");
      expect(listTransfers(stateDir)).toContain(`${transferId}.ready`);
    }),
  );

  it.effect("caps each artifact and the node's pending bytes", () =>
    Effect.gen(function* () {
      const transfers = yield* openStore(makeStateDir(), { capacityBytes: 1000 });
      const sha = sha256(randomBytes(1));
      const avatar = yield* Effect.flip(
        transfers.begin({
          transferId: newTransferId(),
          purpose: "avatar",
          byteLength: PROJECT_COPY_MAX_AVATAR_BYTES + 1,
          sha256: sha,
        }),
      );
      expect(avatar.code).toBe("too-large");
      const bundle = yield* Effect.flip(
        transfers.begin({
          transferId: newTransferId(),
          purpose: "repository-bundle",
          byteLength: PROJECT_COPY_MAX_ARTIFACT_BYTES + 1,
          sha256: sha,
        }),
      );
      expect(bundle.code).toBe("too-large");

      const first = randomBytes(600);
      const firstId = newTransferId();
      yield* beginFor(transfers, firstId, first);
      const full = yield* Effect.flip(beginFor(transfers, newTransferId(), randomBytes(600)));
      expect(full.code).toBe("capacity");
      yield* transfers.abort({ transferId: firstId });
      yield* beginFor(transfers, newTransferId(), randomBytes(600));
    }),
  );

  it.effect("does not count claimed transfers against the node's pending bytes", () =>
    Effect.gen(function* () {
      const transfers = yield* openStore(makeStateDir(), { capacityBytes: 1000 });
      const transferId = yield* uploadCommitted(transfers, randomBytes(600));
      yield* transfers.claimForImport({
        importId: newImportId(),
        transfers: [{ transferId, purpose: "commits-bundle" }],
      });
      yield* beginFor(transfers, newTransferId(), randomBytes(600));
    }),
  );

  it.effect("aborts unclaimed transfers and leaves claimed ones to their import", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const transfers = yield* openStore(stateDir);
      const open = newTransferId();
      yield* beginFor(transfers, open, randomBytes(100));
      yield* transfers.abort({ transferId: open });
      yield* transfers.abort({ transferId: open });
      expect(listTransfers(stateDir)).toEqual([]);
      const missing = yield* Effect.flip(
        transfers.append({ transferId: open, offset: 0, dataBase64: chunk(randomBytes(4), 0) }),
      );
      expect(missing.code).toBe("not-found");

      const claimedId = yield* uploadCommitted(transfers, randomBytes(100), "avatar");
      const importId = newImportId();
      const [claimed] = yield* transfers.claimForImport({
        importId,
        transfers: [{ transferId: claimedId, purpose: "avatar" }],
      });
      yield* transfers.abort({ transferId: claimedId });
      expect(fs.existsSync(claimed!.path)).toBe(true);
    }),
  );

  it.effect("claims all of an import's transfers or none of them", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const transfers = yield* openStore(stateDir);
      const commits = yield* uploadCommitted(transfers, randomBytes(700), "commits-bundle");
      const changes = yield* uploadCommitted(transfers, randomBytes(300), "changes-patch");
      const open = newTransferId();
      yield* beginFor(transfers, open, randomBytes(50), "avatar");
      const importId = newImportId();

      const wrongPurpose = yield* Effect.flip(
        transfers.claimForImport({
          importId,
          transfers: [
            { transferId: commits, purpose: "commits-bundle" },
            { transferId: changes, purpose: "avatar" },
          ],
        }),
      );
      expect(wrongPurpose.code).toBe("invalid");
      const uncommitted = yield* Effect.flip(
        transfers.claimForImport({
          importId,
          transfers: [
            { transferId: commits, purpose: "commits-bundle" },
            { transferId: open, purpose: "avatar" },
          ],
        }),
      );
      expect(uncommitted.code).toBe("invalid");
      const unknown = yield* Effect.flip(
        transfers.claimForImport({
          importId,
          transfers: [
            { transferId: commits, purpose: "commits-bundle" },
            { transferId: newTransferId(), purpose: "changes-patch" },
          ],
        }),
      );
      expect(unknown.code).toBe("not-found");
      expect(listTransfers(stateDir)).toContain(`${commits}.ready`);
      expect(fs.existsSync(path.join(importsDir(stateDir), importId))).toBe(false);

      const request = {
        importId,
        transfers: [
          { transferId: commits, purpose: "commits-bundle" as const },
          { transferId: changes, purpose: "changes-patch" as const },
        ],
      };
      const claimed = yield* transfers.claimForImport(request);
      expect(claimed.map((file) => path.basename(file.path))).toEqual([
        `${commits}.commits-bundle`,
        `${changes}.changes-patch`,
      ]);
      expect(yield* transfers.claimForImport(request)).toEqual(claimed);
      const other = yield* Effect.flip(
        transfers.claimForImport({ ...request, importId: newImportId() }),
      );
      expect(other.code).toBe("conflict");
    }),
  );

  it.effect("refuses a claim whose bytes changed since the commit", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const transfers = yield* openStore(stateDir);
      const bytes = randomBytes(2048);
      const transferId = yield* uploadCommitted(transfers, bytes);
      fs.writeFileSync(path.join(transfersDir(stateDir), `${transferId}.ready`), randomBytes(2048));

      const error = yield* Effect.flip(
        transfers.claimForImport({
          importId: newImportId(),
          transfers: [{ transferId, purpose: "commits-bundle" }],
        }),
      );
      expect(error.code).toBe("invalid");
      expect(listTransfers(stateDir)).toEqual([]);
      expect((yield* beginFor(transfers, transferId, bytes)).receivedBytes).toBe(0);
    }),
  );

  it.effect("expires idle unclaimed transfers an hour after their last append", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const transfers = yield* openStore(stateDir);
      const bytes = randomBytes(1000);
      const active = newTransferId();
      yield* beginFor(transfers, active, bytes);
      const committed = yield* uploadCommitted(transfers, randomBytes(100));
      const claimedId = yield* uploadCommitted(transfers, randomBytes(100), "changes-patch");
      const [claimed] = yield* transfers.claimForImport({
        importId: newImportId(),
        transfers: [{ transferId: claimedId, purpose: "changes-patch" }],
      });

      yield* TestClock.adjust(Duration.minutes(30));
      yield* transfers.append({ transferId: active, offset: 0, dataBase64: chunk(bytes, 0, 500) });
      yield* TestClock.adjust(Duration.minutes(31));
      yield* transfers.sweep();
      expect(listTransfers(stateDir)).toEqual([`${active}.json`, `${active}.part`]);
      const gone = yield* Effect.flip(transfers.commit({ transferId: committed }));
      expect(gone.code).toBe("not-found");

      yield* TestClock.adjust(Duration.minutes(30));
      yield* transfers.sweep();
      expect(listTransfers(stateDir)).toEqual([]);
      expect(fs.existsSync(claimed!.path)).toBe(true);
    }),
  );

  it.effect("deletes orphans at startup and finishes an interrupted claim", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const kept = randomBytes(800);
      const keptId = newTransferId();
      const claimedBytes = randomBytes(400);
      const claimedId = newTransferId();
      const importId = newImportId();
      const oversized = randomBytes(100);
      const oversizedId = newTransferId();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const transfers = yield* openStore(stateDir);
          yield* beginFor(transfers, oversizedId, oversized);
          yield* beginFor(transfers, keptId, kept);
          yield* transfers.append({
            transferId: keptId,
            offset: 0,
            dataBase64: chunk(kept, 0, 300),
          });
          yield* beginFor(transfers, claimedId, claimedBytes);
          yield* appendAll(transfers, claimedId, claimedBytes);
          yield* transfers.commit({ transferId: claimedId });
        }),
      );
      // A claim that moved the data and crashed before its sidecar followed.
      fs.mkdirSync(path.join(importsDir(stateDir), importId), { recursive: true });
      fs.renameSync(
        path.join(transfersDir(stateDir), `${claimedId}.ready`),
        path.join(importsDir(stateDir), importId, `${claimedId}.commits-bundle`),
      );
      const sidecarOnly = newTransferId();
      const dataOnly = newTransferId();
      const corrupt = newTransferId();
      const strayClaim = newTransferId();
      const write = (name: string, contents: string | Uint8Array) =>
        fs.writeFileSync(path.join(transfersDir(stateDir), name), contents);
      write("notes.txt", "stray");
      write(`${oversizedId}.part`, randomBytes(200));
      write(`${dataOnly}.part`, randomBytes(10));
      write(
        `${sidecarOnly}.json`,
        fs.readFileSync(path.join(transfersDir(stateDir), `${keptId}.json`)),
      );
      write(`${corrupt}.json`, "{");
      write(`${corrupt}.part`, randomBytes(10));
      fs.mkdirSync(path.join(transfersDir(stateDir), `${keptId}.json.tmp`));
      fs.writeFileSync(path.join(importsDir(stateDir), importId, `${strayClaim}.json`), "{}");
      fs.writeFileSync(path.join(importsDir(stateDir), importId, "job.log"), "kept");

      const transfers = yield* openStore(stateDir);
      expect(listTransfers(stateDir)).toEqual(
        [
          `${keptId}.json`,
          `${keptId}.part`,
          `${oversizedId}.json`,
          `${oversizedId}.part`,
        ].toSorted(),
      );
      // More bytes than declared: the upload starts over.
      expect((yield* beginFor(transfers, oversizedId, oversized)).receivedBytes).toBe(0);
      expect(fs.statSync(path.join(transfersDir(stateDir), `${oversizedId}.part`)).size).toBe(0);
      expect(fs.readdirSync(path.join(importsDir(stateDir), importId)).toSorted()).toEqual(
        [`${claimedId}.commits-bundle`, `${claimedId}.json`, "job.log"].toSorted(),
      );
      expect((yield* beginFor(transfers, keptId, kept)).receivedBytes).toBe(300);
      const [claimed] = yield* transfers.claimForImport({
        importId,
        transfers: [{ transferId: claimedId, purpose: "commits-bundle" }],
      });
      expect(Buffer.compare(fs.readFileSync(claimed!.path), claimedBytes)).toBe(0);
    }),
  );

  it.effect("never names a file after an id that is not a UUID", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const transfers = yield* openStore(stateDir);
      const evil = "../../escape" as ProjectTransferId;
      const begin = yield* Effect.flip(
        transfers.begin({
          transferId: evil,
          purpose: "avatar",
          byteLength: 1,
          sha256: "0".repeat(64),
        }),
      );
      expect(begin.code).toBe("invalid");
      const append = yield* Effect.flip(
        transfers.append({ transferId: evil, offset: 0, dataBase64: "AA==" }),
      );
      expect(append.code).toBe("invalid");
      const claim = yield* Effect.flip(
        transfers.claimForImport({ importId: "../x" as ProjectImportId, transfers: [] }),
      );
      expect(claim.code).toBe("invalid");
      fs.writeFileSync(path.join(stateDir, "keep.txt"), "keep");
      yield* transfers.releaseImport(".." as ProjectImportId);
      expect(fs.existsSync(path.join(stateDir, "keep.txt"))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "escape"))).toBe(false);
    }),
  );
});
