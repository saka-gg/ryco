/**
 * The editor's token popovers and menus (the lab's `pickerPop` and
 * `menuPop`): each grows out of its token and lands under the whole
 * sentence at the token's x, inside the dialog (`tokenAnchor`). Pickers sit
 * in a popover under a small heading; choices are a radio menu with
 * first-letter type-ahead, two-line items and a check on the current one.
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon } from "lucide-react";
import { useId, useMemo, useRef, type ReactElement, type ReactNode } from "react";

import { cn } from "../../../../lib/utils";
import { Menu, MenuPopup, MenuTrigger } from "../../../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../../ui/popover";
import type { EditorTokenKind } from "./editorModel.logic";
import { findEditorToken, findTokenPopup, tokenAnchor, tokenPopupId } from "./tokenAnchor";

/** How far under the sentence a picker lands (the lab's 8px; menus 6px). */
const PICKER_GAP = 8;
const MENU_GAP = 6;

export interface TokenPopoverProps {
  readonly editorId: string;
  readonly kind: EditorTokenKind;
  /** The heading over the picker ("Repeat every", "First run", "Ends"). */
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The token: a `<button>` Base UI turns into the trigger. */
  readonly trigger: ReactElement;
  /** What takes focus as it opens, inside the popup (a CSS selector). */
  readonly initialFocus?: string | undefined;
  readonly children: ReactNode;
}

/** A picker in a token popover. */
export function TokenPopover(props: TokenPopoverProps) {
  const { editorId, kind } = props;
  const titleId = useId();
  const anchor = useMemo(() => tokenAnchor(editorId, kind, PICKER_GAP), [editorId, kind]);
  const selector = props.initialFocus;
  return (
    <Popover open={props.open} onOpenChange={(next) => props.onOpenChange(next)}>
      <PopoverTrigger render={props.trigger} />
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={PICKER_GAP}
        morph={{ origin: () => findEditorToken(editorId, kind) }}
        className="ae-pop"
        viewportClassName="p-0 [--viewport-inline-padding:0]"
        aria-labelledby={titleId}
        data-ae-pop={tokenPopupId(editorId, kind)}
        initialFocus={
          selector
            ? () => findTokenPopup(editorId, kind)?.querySelector<HTMLElement>(selector) ?? true
            : true
        }
      >
        <div className="ae-pp">
          <div className="ae-pp-h" id={titleId}>
            {props.title}
          </div>
          {props.children}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export interface TokenMenuItem<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** A second line under the label. */
  readonly hint?: string | undefined;
  readonly icon?: ReactNode;
  /** Quiet trailing text (a checkout's path). */
  readonly aside?: ReactNode;
  readonly ariaLabel?: string | undefined;
}

export interface TokenMenuProps<Value extends string> {
  readonly editorId: string;
  readonly kind: EditorTokenKind;
  readonly label: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: ReactElement;
  readonly value: Value;
  readonly items: ReadonlyArray<TokenMenuItem<Value>>;
  readonly onPick: (value: Value) => void;
  /** Two-line menus are wider (the lab's 300px). */
  readonly wide?: boolean | undefined;
}

/** The checked choice of an open token menu. */
function checkedMenuItem(popup: HTMLElement): HTMLElement | null {
  return popup.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]');
}

/** A choice in a token menu (device, where it runs, permissions). */
export function TokenMenu<Value extends string>(props: TokenMenuProps<Value>) {
  const { editorId, kind } = props;
  const anchor = useMemo(() => tokenAnchor(editorId, kind, MENU_GAP), [editorId, kind]);
  /*
   * A menu opens on the current choice (the lab's `menuPop` initial focus),
   * so ↑/↓ move from it. Base UI lands on the first item (or the popup);
   * until the reader moves — a key or the pointer in the menu — focus that
   * arrives anywhere else is handed to the checked item, whose focus moves
   * the highlight with it.
   */
  const steerRef = useRef(true);
  const settle = () => {
    steerRef.current = false;
  };
  return (
    <Menu
      open={props.open}
      onOpenChange={(next) => {
        if (next) steerRef.current = true;
        props.onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) steerRef.current = true;
      }}
    >
      <MenuTrigger render={props.trigger} />
      <MenuPopup
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={MENU_GAP}
        className={cn("ad-menu ae-menu", props.wide && "w-[300px]")}
        aria-label={props.label}
        data-ae-pop={tokenPopupId(editorId, kind)}
        onFocus={(event) => {
          if (!steerRef.current) return;
          const checked = checkedMenuItem(event.currentTarget);
          if (checked && event.target !== checked) checked.focus({ preventScroll: true });
        }}
        onKeyDownCapture={settle}
        onPointerMove={settle}
      >
        <MenuPrimitive.RadioGroup
          value={props.value}
          onValueChange={(value) => {
            const item = props.items.find((candidate) => candidate.value === value);
            if (item) props.onPick(item.value);
          }}
        >
          {props.items.map((item) => (
            <MenuPrimitive.RadioItem
              key={item.value}
              value={item.value}
              closeOnClick
              className={cn("ad-mi", item.hint && "ad-mi2")}
              aria-label={item.ariaLabel ?? item.label}
              label={item.label}
            >
              {item.icon}
              <span className="ad-mi-t">
                <span className="ad-mi-l ad-trunc">{item.label}</span>
                {item.hint ? <span className="ad-mi-h">{item.hint}</span> : null}
              </span>
              {item.aside ? (
                <span className="ad-mi-a" aria-hidden="true">
                  {item.aside}
                </span>
              ) : null}
              <span className="ad-mi-ck-slot">
                <MenuPrimitive.RadioItemIndicator className="ad-mi-ck">
                  <CheckIcon aria-hidden="true" />
                </MenuPrimitive.RadioItemIndicator>
              </span>
            </MenuPrimitive.RadioItem>
          ))}
        </MenuPrimitive.RadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The popover the model pick opens: the app's model picker paints its own surface. */
export function ModelPickPopover(props: {
  readonly editorId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: ReactElement;
  readonly children: ReactNode;
}) {
  const { editorId } = props;
  const anchor = useMemo(() => tokenAnchor(editorId, "model", MENU_GAP), [editorId]);
  return (
    <Popover open={props.open} onOpenChange={(next) => props.onOpenChange(next)}>
      <PopoverTrigger render={props.trigger} />
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={MENU_GAP}
        morph={{ origin: () => findEditorToken(editorId, "model") }}
        aria-label="Model and effort"
        data-ae-pop={tokenPopupId(editorId, "model")}
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
      >
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}
