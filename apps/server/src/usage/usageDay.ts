// @effect-diagnostics globalDate:off

/** Formats a timestamp as the `YYYY-MM-DD` calendar day it falls on in `timeZone`. */
export function makeUsageDayFormatter(timeZone: string): (timestampMs: number) => string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (timestampMs) => formatter.format(new Date(timestampMs));
}
