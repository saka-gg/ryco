import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

/**
 * A device tab's context menu, opened at the pointer. Self-contained and
 * loaded on the first right-click: as another importer of the shared menu
 * primitives it re-partitioned their shared chunks, which pulled unrelated
 * icons into the chat route.
 */
export default function DeviceTabMenu(props: {
  readonly x: number;
  readonly y: number;
  readonly canFloat: boolean;
  readonly onRename: () => void;
  readonly onFloat: () => void;
  readonly onCloseTab: () => void;
  readonly onDismiss: () => void;
}) {
  // Stable from the opener, so the effect below runs once, when the menu opens.
  const { onDismiss } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const dismiss = (event: Event) => {
      if (event instanceof PointerEvent && menuRef.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [onDismiss]);

  const choose = (action: () => void) => () => {
    onDismiss();
    action();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };
  const item =
    "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground";
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Device tab"
      className="selection-glass-surface fixed z-50 min-w-40 rounded-lg border p-1 text-popover-foreground shadow-lg"
      style={{
        left: Math.min(props.x, window.innerWidth - 180),
        top: Math.min(props.y, window.innerHeight - 120),
      }}
      onKeyDown={onKeyDown}
    >
      <button type="button" role="menuitem" className={item} onClick={choose(props.onRename)}>
        Rename
      </button>
      {props.canFloat ? (
        <button type="button" role="menuitem" className={item} onClick={choose(props.onFloat)}>
          Float device over chat
        </button>
      ) : null}
      <button type="button" role="menuitem" className={item} onClick={choose(props.onCloseTab)}>
        Close tab
      </button>
    </div>,
    document.body,
  );
}
