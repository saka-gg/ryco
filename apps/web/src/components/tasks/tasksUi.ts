/**
 * Class names the Tasks page's parts share, so a chip, a menu and a popover
 * row look the same wherever they appear. States and motion live in
 * `tasks.css`; these are the static layout.
 */

// The contract's title and notes limits (`localTasks.ts`), enforced as typed.
export const TASK_TITLE_MAX_LENGTH = 500;
export const TASK_NOTES_MAX_LENGTH = 20_000;

/** A 24px property chip (project, due date, link, file); `data-ghost` makes it dashed. */
export const TASK_CHIP_CLASS =
  "tsk-chip relative inline-flex h-[24px] max-w-[280px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[7px] border border-border bg-transparent px-[8px] text-[12px] text-muted-foreground outline-none";

/** The label inside a chip: truncates instead of growing the chip past its cap. */
export const TASK_CHIP_LABEL_CLASS = "tsk-chip-label min-w-0 truncate";

/** The hover × of a removable chip, laid over the label's end. */
export const TASK_CHIP_REMOVE_CLASS =
  "tsk-chip-x absolute top-1/2 right-[3px] grid size-[18px] -translate-y-1/2 place-items-center rounded-[5px] text-muted-foreground hover:text-foreground";

/** Menus and popovers of the page: the prototype's 250px floating list. */
export const TASK_MENU_POPUP_CLASS = "tsk-pop min-w-[250px] rounded-[10px]";

/** A menu row with an icon, a title and a quiet second line. */
export const TASK_MENU_ITEM_CLASS =
  "min-h-0 cursor-pointer items-start gap-[9px] rounded-[6px] px-[8px] py-[7px] text-[12.5px] text-foreground data-highlighted:bg-accent data-highlighted:text-foreground sm:min-h-0 sm:text-[12.5px] [&>svg]:mt-[2px]";

/** The same row as a plain button, inside a popover. */
export const TASK_POPOVER_ITEM_CLASS =
  "tsk-pop-item flex w-full cursor-pointer items-start gap-[9px] rounded-[6px] border-0 bg-transparent px-[8px] py-[7px] text-left text-[12.5px] text-foreground";

/** The second line of a menu row. */
export const TASK_MENU_DETAIL_CLASS = "mt-px block text-[11.5px] text-(--task-faint)";

/** A text field inside a task popover. */
export const TASK_POPOVER_INPUT_CLASS =
  "tsk-pop-input h-[30px] w-full rounded-[7px] border border-border bg-transparent px-[9px] text-[12.5px] text-foreground outline-none";
