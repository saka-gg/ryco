import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import type { StatisticsSearch } from "./statisticsSearch";

/** A link can name several environments; the menu picks one or all. */
const SEVERAL_ENVIRONMENTS = "__several__";

/** Narrows a statistics view to one connected environment, or widens it to all of them. */
export function EnvironmentSelect(props: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
  readonly environments: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  readonly ariaLabel: string;
}) {
  const { search } = props;
  const ids = search.environmentIds ?? [];
  const value = ids.length === 0 ? "all" : ids.length === 1 ? ids[0]! : SEVERAL_ENVIRONMENTS;
  return (
    <Select
      value={value}
      onValueChange={(next: string | null) =>
        props.onSearchChange({
          ...search,
          ...(next === null || next === "all"
            ? { environmentIds: undefined }
            : { environmentIds: [next] }),
        })
      }
    >
      <SelectTrigger size="sm" className="w-48" aria-label={props.ariaLabel}>
        <SelectValue>
          {value === "all"
            ? `All environments (${props.environments.length})`
            : value === SEVERAL_ENVIRONMENTS
              ? `${ids.length} environments`
              : (props.environments.find((item) => item.environmentId === value)?.label ??
                "Environment")}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem value="all">All environments</SelectItem>
        {props.environments.map((environment) => (
          <SelectItem key={environment.environmentId} value={environment.environmentId}>
            {environment.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
