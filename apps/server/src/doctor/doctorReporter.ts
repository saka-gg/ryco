/**
 * doctorReporter - how `ryco doctor` shows its progress on stderr: on a terminal one line per
 * step that updates in place; otherwise (a log, a pipe) one line per step and one per 10% of a
 * long step, so a service log or CI transcript stays short.
 *
 * @module doctorReporter
 */
import { Effect } from "effect";

import type { DoctorReporter } from "./DatabaseDoctor.ts";

export interface TerminalDoctorReporter extends DoctorReporter {
  /** Ends an open progress line (before the summary is printed). */
  readonly end: Effect.Effect<void>;
}

export function makeTerminalDoctorReporter(input: {
  readonly tty: boolean;
  readonly write: (text: string) => void;
}): TerminalDoctorReporter {
  let phase = "";
  let lineOpen = false;
  let reportedTenths = 0;
  const closeLine = () => {
    if (lineOpen) input.write("\n");
    lineOpen = false;
  };
  return {
    phase: (text) =>
      Effect.sync(() => {
        closeLine();
        phase = text;
        reportedTenths = 0;
        if (input.tty) {
          input.write(`${text}...`);
          lineOpen = true;
        } else {
          input.write(`${text}...\n`);
        }
      }),
    progress: (text, fraction) =>
      Effect.sync(() => {
        if (input.tty) {
          input.write(`\r\u001b[2K${phase}: ${text}`);
          lineOpen = true;
          return;
        }
        if (fraction === null) return;
        const tenths = Math.min(10, Math.floor(Math.max(0, fraction) * 10));
        if (tenths <= reportedTenths) return;
        reportedTenths = tenths;
        input.write(`  ${tenths * 10}%: ${text}\n`);
      }),
    note: (text) =>
      Effect.sync(() => {
        closeLine();
        input.write(`${text}\n`);
      }),
    end: Effect.sync(closeLine),
  };
}
