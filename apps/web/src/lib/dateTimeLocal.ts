/**
 * A `<input type="datetime-local">` holds a wall time without a zone, which
 * the browser reads as local time. Both directions go through local time, so
 * a value shown and saved back unchanged keeps its instant.
 */

/** An ISO instant as the field's local "YYYY-MM-DDTHH:mm" value. */
export function toDateTimeLocalInputValue(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The field's local value as an ISO instant. */
export function fromDateTimeLocalInputValue(value: string): string {
  return new Date(value).toISOString();
}
