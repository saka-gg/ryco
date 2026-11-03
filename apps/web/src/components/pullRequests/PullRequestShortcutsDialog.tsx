import type { ScriptShortcutScope } from "@ryco/client-runtime/state/settings";

import { useAppKeybindings } from "../../appKeybindings";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { KeyHint } from "./primitives";

type ShortcutRow = readonly [keys: ReadonlyArray<string>, label: string];

const SHORTCUT_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly rows: ReadonlyArray<ShortcutRow>;
  /** Also lists the find key (the user's thread-find binding) here. */
  readonly findRow?: true;
}> = [
  {
    title: "Move",
    rows: [
      [["J", "K"], "Next / previous in the list (files on Files)"],
      [["⇧J", "⇧K"], "Next / previous pull request"],
      [["[", "]"], "Layer below / above in the stack"],
      [["1", "2", "3", "4"], "Conversation, Files, Checks, Commits"],
      [["N", "P"], "Next / previous unresolved thread"],
      [["/"], "Search"],
      [["\\"], "Show or hide the list"],
    ],
  },
  {
    title: "Review",
    rows: [
      [["R"], "Review"],
      [["V"], "Mark file viewed and go to the next"],
      [["F"], "File tree"],
      [["U"], "Unified / split diff"],
      [["C"], "Commit scope"],
      [["⌘", "↵"], "Submit comment or review"],
    ],
    findRow: true,
  },
  {
    title: "Act",
    rows: [
      [["M"], "Next action"],
      [["S"], "Stack"],
      [["A"], "Ask an agent"],
      [["E"], "Edit title"],
      [["O"], "Open on GitHub"],
      [["?"], "This list"],
    ],
  },
];

export function PullRequestShortcutsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The repository's project: a project shortcut on the same key takes it there. */
  readonly scope?: ScriptShortcutScope | null | undefined;
}) {
  const keybindings = useAppKeybindings(props.scope ?? null);
  // Find in the diff follows the thread-find binding, so the row shows that key;
  // none when nothing is bound to it (or the key runs a project shortcut here).
  const findKey = shortcutLabelForCommand(keybindings, "thread.find");
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Pull requests page. Shortcuts pause while you type.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-6 pb-6">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="grid gap-2">
              <h3 className="text-[11px] text-muted-foreground">{group.title}</h3>
              <dl className="grid gap-1.5">
                {group.rows.map(([keys, label]) => (
                  <ShortcutRowView key={label} keys={keys} label={label} />
                ))}
                {group.findRow && findKey !== null ? (
                  <ShortcutRowView keys={[findKey]} label="Find in the diff" />
                ) : null}
              </dl>
            </section>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ShortcutRowView(props: { readonly keys: ReadonlyArray<string>; readonly label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-[13px]">
      <dt className="text-foreground/90">{props.label}</dt>
      <dd className="flex shrink-0 items-center gap-1">
        {props.keys.map((key) => (
          <KeyHint key={key}>{key}</KeyHint>
        ))}
      </dd>
    </div>
  );
}
