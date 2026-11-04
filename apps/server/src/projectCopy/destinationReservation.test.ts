import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  projectDestinationReservationKey,
  tryReserveProjectDestination,
  withProjectDestinationReservation,
} from "./destinationReservation.ts";

const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryco-reservation-")));

describe("destinationReservation", () => {
  it.effect("keys a destination on its identity, not its spelling", () =>
    Effect.gen(function* () {
      const root = tempDir();
      fs.mkdirSync(path.join(root, "Code"));
      fs.symlinkSync(path.join(root, "Code"), path.join(root, "link"));
      const direct = yield* projectDestinationReservationKey(path.join(root, "Code", "app", "web"));
      const viaLink = yield* projectDestinationReservationKey(
        path.join(root, "link", "app", "web"),
      );
      assert.equal(viaLink, direct);
      const otherCase = yield* projectDestinationReservationKey(
        path.join(root, "CODE", "app", "web"),
      );
      // Case-insensitive volumes fold the key; case-sensitive ones keep two folders apart.
      const insensitive = fs.existsSync(path.join(root, "CODE"));
      assert.equal(otherCase === direct, insensitive);
      // `~/…` is the home directory, as the legacy clone's destination field allows.
      assert.equal(
        yield* projectDestinationReservationKey("~/ryco-reservation-missing/app"),
        yield* projectDestinationReservationKey(
          path.join(os.homedir(), "ryco-reservation-missing", "app"),
        ),
      );
    }),
  );

  it.effect("lets one operation hold a destination at a time", () =>
    Effect.gen(function* () {
      const destination = path.join(tempDir(), "app");
      const key = yield* projectDestinationReservationKey(destination);
      const release = tryReserveProjectDestination(key, "import");
      assert.isNotNull(release);
      assert.isNull(tryReserveProjectDestination(key, "clone"));
      const refused = yield* Effect.succeed("cloned").pipe(
        withProjectDestinationReservation({
          destinationPath: destination,
          holder: "clone",
          onReserved: (message) => message,
        }),
        Effect.flip,
      );
      assert.include(refused, destination);
      release!();
      release!();
      const cloned = yield* Effect.succeed("cloned").pipe(
        withProjectDestinationReservation({
          destinationPath: destination,
          holder: "clone",
          onReserved: (message) => message,
        }),
      );
      assert.equal(cloned, "cloned");
      // Released again however the wrapped run ended.
      const next = tryReserveProjectDestination(key, "import");
      assert.isNotNull(next);
      next!();
    }),
  );
});
