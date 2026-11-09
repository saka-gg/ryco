// The due-day picker's month grid, pure so it is testable: whole weeks from
// Monday, the days of the neighbouring months filling the first and last week.

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const CALENDAR_WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;

export interface CalendarDay {
  /** Local midnight of the day. */
  readonly dayMs: number;
  readonly day: number;
  readonly inMonth: boolean;
}

export interface CalendarMonth {
  readonly year: number;
  /** 0 = January. */
  readonly month: number;
  readonly title: string;
  readonly weeks: ReadonlyArray<ReadonlyArray<CalendarDay>>;
}

/** Monday 0 … Sunday 6. */
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function calendarMonth(year: number, month: number): CalendarMonth {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - mondayIndex(first));
  const weeks: CalendarDay[][] = [];
  const cursor = new Date(start);
  do {
    const week: CalendarDay[] = [];
    for (let index = 0; index < 7; index += 1) {
      week.push({
        dayMs: new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()).getTime(),
        day: cursor.getDate(),
        inMonth: cursor.getMonth() === month,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  } while (cursor.getMonth() === month);
  return { year, month, title: `${MONTH_NAMES[month]} ${year}`, weeks };
}

/** The month `delta` months from the given one. */
export function shiftCalendarMonth(
  year: number,
  month: number,
  delta: number,
): { readonly year: number; readonly month: number } {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}
