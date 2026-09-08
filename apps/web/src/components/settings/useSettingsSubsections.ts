import { useEffect, useState } from "react";

export function useSettingsSubsections(section: string, searching: boolean, target: string | null) {
  const [root, contentRef] = useState<HTMLDivElement | null>(null);
  const [sections, setSections] = useState<
    readonly { id: string; title: string; element: HTMLElement }[]
  >([]);
  const [active, setActive] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!root) return;
    const identities = new WeakMap<HTMLElement, string>();
    let nextId = 0;
    let entries: { id: string; title: string; element: HTMLElement }[] = [];
    const track = () => {
      const top = root.getBoundingClientRect().top + 64;
      const current =
        entries.findLast((entry) => entry.element.getBoundingClientRect().top <= top) ?? entries[0];
      setActive(current?.element ?? null);
    };
    let revealed = false;
    const scan = () => {
      entries = searching
        ? []
        : Array.from(root.querySelectorAll<HTMLElement>("[data-settings-section]")).map(
            (element) => {
              if (!identities.has(element)) identities.set(element, `section-${++nextId}`);
              return {
                id: identities.get(element)!,
                title: element.dataset.settingsSection!,
                element,
              };
            },
          );
      setSections((previous) =>
        previous.length === entries.length &&
        previous.every(
          (entry, i) => entry.element === entries[i]?.element && entry.title === entries[i]?.title,
        )
          ? previous
          : entries,
      );
      if (target && !searching && !revealed) {
        const match = Array.from(
          root.querySelectorAll<HTMLElement>("h2, h3, [id], [data-settings-section]"),
        ).find(
          (element) =>
            element.id === target ||
            element.dataset.settingsSection === target ||
            element.textContent?.trim() === target,
        );
        if (match) {
          revealed = true;
          match.scrollIntoView({ block: "center" });
          match.tabIndex = -1;
          match.focus({ preventScroll: true });
        }
      }
      track();
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-settings-section", "aria-current"],
    });
    root.addEventListener("scroll", track, true);
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", track, true);
    };
  }, [root, section, searching, target]);
  return { contentRef, sections, active };
}
