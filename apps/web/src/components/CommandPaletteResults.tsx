import { type ResolvedKeybindingsConfig } from "@ryco/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteItemContent,
  type CommandPaletteRow,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandShortcut,
} from "./ui/command";
import { cn } from "~/lib/utils";

// A row with a description is about this tall; plain rows are shorter.
const ESTIMATED_ROW_SIZE = 40;
// Rows rendered beyond the viewport on each side, in pixels.
const DRAW_DISTANCE = 400;

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

function renderItemContent(content: CommandPaletteItemContent): ReactNode {
  return typeof content === "function" ? content() : content;
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {props.emptyStateMessage ??
          (props.isActionsOnly
            ? "No matching actions."
            : "No matching commands, projects, or threads.")}
      </div>
    );
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          <CommandGroupLabel>{group.label}</CommandGroupLabel>
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

/**
 * Scrolls a keyboard highlight into view the way the plain list does: nearest
 * edge. A row outside the rendered window is scrolled to by the list itself.
 */
export function scrollCommandPaletteRowIntoView(list: LegendListRef | null, rowIndex: number) {
  const element = list?.getState?.().elementAtIndex(rowIndex);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "nearest" });
    return;
  }
  void list?.scrollIndexIntoView?.({ index: rowIndex, animated: false });
}

interface CommandPaletteVirtualizedResultsProps extends Pick<
  CommandPaletteResultsProps,
  "highlightedItemValue" | "keybindings" | "onExecuteItem"
> {
  rows: ReadonlyArray<CommandPaletteRow>;
  listRef: RefObject<LegendListRef | null>;
  /** The list scrolls back to the top when this changes (a new query). */
  scrollResetKey: string;
}

/**
 * Renders only the rows in view of a list too long to be empty. The parent
 * passes the flat item order to the Command root as `items` with
 * `virtualized`, scrolls keyboard highlights into view through `listRef`, and
 * runs Enter itself, since the highlighted row may be unmounted.
 */
export function CommandPaletteVirtualizedResults(props: CommandPaletteVirtualizedResultsProps) {
  const { listRef, scrollResetKey } = props;
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });
  const updateScrollFade = useCallback(() => {
    const scrollElement = listRef.current?.getScrollableNode?.();
    if (!(scrollElement instanceof HTMLElement)) return;
    const top = scrollElement.scrollTop > 1;
    const bottom =
      scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop > 1;
    setScrollFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  }, [listRef]);

  // Base UI resets a plain list's scroll on typing; a virtualized list owns its scroller.
  const scrollResetKeyRef = useRef(scrollResetKey);
  useLayoutEffect(() => {
    if (scrollResetKeyRef.current === scrollResetKey) return;
    scrollResetKeyRef.current = scrollResetKey;
    void listRef.current?.scrollToOffset?.({ offset: 0, animated: false });
  }, [listRef, scrollResetKey]);

  const itemCount = useMemo(
    () => props.rows.filter((row) => row.kind === "item" && row.itemIndex !== null).length,
    [props.rows],
  );

  return (
    <CommandListVirtualized>
      <LegendList<CommandPaletteRow>
        ref={listRef}
        data={props.rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        recycleItems={false}
        extraData={props.highlightedItemValue}
        renderItem={({ item: row }) =>
          row.kind === "label" ? (
            <div className={row.first ? undefined : "pt-1.5"}>
              <CommandListHeading>{row.label}</CommandListHeading>
            </div>
          ) : row.itemIndex === null ? (
            <DisabledCommandPaletteResultRow item={row.item} />
          ) : (
            <CommandPaletteResultRow
              index={row.itemIndex}
              setSize={itemCount}
              item={row.item}
              keybindings={props.keybindings}
              isActive={props.highlightedItemValue === row.item.value}
              onExecuteItem={props.onExecuteItem}
            />
          )
        }
        estimatedItemSize={ESTIMATED_ROW_SIZE}
        drawDistance={DRAW_DISTANCE}
        onLayout={updateScrollFade}
        onScroll={updateScrollFade}
        contentContainerClassName="px-2"
        className={cn(
          // The end padding matches the plain list's scroll area once it overflows, as this one does.
          "min-h-0 scroll-py-2 overflow-x-hidden overscroll-y-contain py-2 pe-1",
          scrollFade.top && "mask-t-from-[calc(100%-1.5rem)]",
          scrollFade.bottom && "mask-b-from-[calc(100%-1.5rem)]",
        )}
      />
    </CommandListVirtualized>
  );
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      {props.item.icon}
      {props.item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {renderItemContent(props.item.titleLeadingContent)}
            <span className="truncate">{props.item.title}</span>
          </span>
          <span className="truncate text-muted-foreground/70 text-xs">
            {props.item.description}
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {renderItemContent(props.item.titleLeadingContent)}
          <span className="truncate">{props.item.title}</span>
        </span>
      )}
      {renderItemContent(props.item.titleTrailingContent)}
    </div>
  );
}

function CommandPaletteResultRow(props: {
  /** The item's position among enabled items; set when the list is virtualized. */
  index?: number;
  /** How many enabled items the virtualized list holds, mounted or not. */
  setSize?: number;
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      {...(props.index === undefined ? {} : { index: props.index })}
      // A virtualized list mounts only some options: tell assistive technology the whole count.
      {...(props.index === undefined || props.setSize === undefined
        ? {}
        : { "aria-posinset": props.index + 1, "aria-setsize": props.setSize })}
      value={props.item.value}
      className={cn(
        "cursor-pointer gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      {props.item.icon}
      {props.item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {renderItemContent(props.item.titleLeadingContent)}
            <span className="truncate">{props.item.title}</span>
          </span>
          <span className="truncate text-muted-foreground/70 text-xs">
            {props.item.description}
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {renderItemContent(props.item.titleLeadingContent)}
          <span className="truncate">{props.item.title}</span>
        </span>
      )}
      {renderItemContent(props.item.titleTrailingContent)}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground/50" />
      ) : null}
    </CommandItem>
  );
}
