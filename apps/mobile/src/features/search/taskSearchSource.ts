import type { SearchGroup, SearchResult } from "./searchModel";

// The Tasks scope's adapter. The Tasks feature's `useTaskSearch(query)`
// (features/tasks) answers in its own shape; this turns that answer into
// Search's group. Typed structurally, so it does not import the feature.

export interface TaskSearchAnswer<Route> {
  readonly results: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly subtitle: string;
    readonly done: boolean;
    readonly trailing: string | null;
    /** The screen that opens the task. */
    readonly route: Route;
  }>;
  readonly loading: boolean;
}

export function taskSearchGroup<Route>(
  answer: TaskSearchAnswer<Route>,
  open: (route: Route) => void,
): SearchGroup {
  const results = answer.results.map((result): SearchResult => ({
    key: `task:${result.key}`,
    scope: "tasks",
    icon: result.done ? "checkmark.circle" : "checklist",
    title: result.title,
    detail: result.subtitle,
    ...(result.trailing ? { trailing: result.trailing } : {}),
    accessibilityLabel: `Task, ${result.title}${result.done ? ", done" : ""}, ${result.subtitle}`,
    open: () => open(result.route),
  }));
  return { scope: "tasks", results, loading: answer.loading };
}
