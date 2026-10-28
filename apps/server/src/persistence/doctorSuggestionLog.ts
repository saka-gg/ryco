/**
 * doctorSuggestionLog - the once-per-boot log line suggesting `ryco doctor` when the database
 * could shrink a lot offline (`logDoctorSuggestionOnce` in `databaseStorageReport.ts`).
 *
 * The report loads with `import()` when the delay ends, so neither it nor the doctor suggestion
 * is on the server's boot path (serverBundleBoundaries.test.ts).
 *
 * @module doctorSuggestionLog
 */
import { Effect, Layer } from "effect";

/** When the boot log looks: after the first compaction pass (10 minutes), which sets the estimate. */
export const DOCTOR_SUGGESTION_LOG_DELAY = "15 minutes";

export const DoctorSuggestionLogLive = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.delay(
      Effect.promise(() => import("./databaseStorageReport.ts")).pipe(
        Effect.flatMap((report) => report.logDoctorSuggestionOnce),
      ),
      DOCTOR_SUGGESTION_LOG_DELAY,
    ),
  ),
);
