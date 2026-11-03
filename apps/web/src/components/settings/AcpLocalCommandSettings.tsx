import { useEffect, useRef, useState } from "react";
import { ACP_LOCAL_COMMAND_MAX_ARGS, WS_METHODS } from "@ryco/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useSettingsTarget } from "../../settingsTarget";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hostedCapabilityCopy } from "../../hostedHub/switchTarget";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input, type InputProps } from "../ui/input";
import {
  acpLocalCommandError,
  sameLocalCommand,
  settlePublishedCommands,
  type AcpLocalCommand,
} from "./acpAgentConfig.logic";

interface ArgumentRow {
  readonly id: string;
  readonly value: string;
}

interface CommandDraft {
  /** The executable as typed; it is trimmed when published. */
  readonly command: string;
  readonly rows: ReadonlyArray<ArgumentRow>;
}

let argumentRowCount = 0;
/** Rows for `args`, reusing ids by position so a field being edited stays mounted. */
const argumentRows = (
  args: ReadonlyArray<string>,
  previous: ReadonlyArray<ArgumentRow> = [],
): ReadonlyArray<ArgumentRow> =>
  args.map((value, index) => ({
    id: previous[index]?.id ?? `acp-argument-${argumentRowCount++}`,
    value,
  }));

/**
 * A text field that publishes every change in the add dialog, which only edits a local draft, and
 * on blur or Enter in an instance card, where every saved change rebuilds the instance on the node.
 */
function CommandField({
  commitOnChange,
  value,
  onValueChange,
  ...props
}: Omit<InputProps, "value" | "onChange" | "defaultValue"> & {
  readonly commitOnChange: boolean;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}) {
  return commitOnChange ? (
    <Input {...props} value={value} onChange={(event) => onValueChange(event.target.value)} />
  ) : (
    <DraftInput {...props} value={value} onCommit={onValueChange} />
  );
}

/** Edits a local ACP command: an executable already on the node and its literal arguments. */
export function AcpLocalCommandSettings({
  config,
  commitOnChange,
  onChange,
}: {
  readonly config: AcpLocalCommand;
  readonly commitOnChange: boolean;
  readonly onChange: (next: AcpLocalCommand) => void;
}) {
  const target = useSettingsTarget();
  const capability = useHostedRpcCapability(
    WS_METHODS.serverUpdateSettings,
    target?.environmentId ?? null,
  );
  const canEdit =
    capability.allowed &&
    (!target || (target.connected && target.canManage !== false && target.canMutate !== false));
  const nodeLabel = target?.nodeLabel || "this node";
  // The fields show local state and publish from it, so an edit made before a remote node echoes
  // the previous ones builds on them rather than on the config the node last reported.
  const [draft, setDraft] = useState<CommandDraft>(() => ({
    command: config.command,
    rows: argumentRows(config.args),
  }));
  // What the fields hold, as it would be published.
  const localRef = useRef<AcpLocalCommand>({ command: config.command, args: config.args });
  // Published edits the config does not reflect yet, oldest first.
  const pendingRef = useRef<ReadonlyArray<AcpLocalCommand>>([]);
  // The config last reported. A re-render or a repeated report of it settles nothing, even when it
  // equals an edit still on its way (an edit can return the fields to the saved command).
  const reportedRef = useRef<AcpLocalCommand>({ command: config.command, args: config.args });

  useEffect(() => {
    const reported = { command: config.command, args: config.args };
    if (sameLocalCommand(reported, reportedRef.current)) return;
    reportedRef.current = reported;
    const remaining = settlePublishedCommands(pendingRef.current, reported);
    // The echo of an edit made here: later edits are still on their way, so keep the fields.
    if (remaining) {
      pendingRef.current = remaining;
      return;
    }
    // Changed somewhere else: another client, or a rejected write the node reverted.
    pendingRef.current = [];
    if (sameLocalCommand(reported, localRef.current)) return;
    localRef.current = reported;
    setDraft((current) => ({
      command: reported.command,
      rows: argumentRows(reported.args, current.rows),
    }));
  }, [config.command, config.args]);

  const publish = (next: {
    readonly command?: string;
    readonly rows?: ReadonlyArray<ArgumentRow>;
  }) => {
    const nextDraft = { command: next.command ?? draft.command, rows: next.rows ?? draft.rows };
    setDraft(nextDraft);
    const published = {
      command: nextDraft.command.trim(),
      args: nextDraft.rows.map((row) => row.value),
    };
    // Whitespace around the executable is not saved, so typing only that changes nothing.
    if (sameLocalCommand(published, localRef.current)) return;
    localRef.current = published;
    pendingRef.current = [...pendingRef.current, published];
    onChange(published);
  };

  const commandError = acpLocalCommandError(draft.command);

  return (
    <div className="grid gap-3">
      <div className="space-y-1">
        <p className="text-xs font-medium">Local command</p>
        <p className="text-xs text-muted-foreground">
          Ryco starts this command on {nodeLabel} without a shell, with that node’s permissions.
          Arguments are visible to anyone who can view settings; keep credentials in Environment
          variables marked Sensitive.
        </p>
      </div>
      <label className="grid gap-1">
        <span className="text-xs font-medium">Executable</span>
        <CommandField
          commitOnChange={commitOnChange}
          aria-label="Executable"
          placeholder="gemini or /usr/local/bin/agent"
          maxLength={4096}
          value={draft.command}
          disabled={!canEdit}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={commandError !== null || undefined}
          // A card shows the saved form; the dialog keeps what is typed, spaces inside paths too.
          onValueChange={(command) =>
            publish({ command: commitOnChange ? command : command.trim() })
          }
        />
        <span
          className={commandError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {commandError ??
            "An absolute path or a command name on the node’s PATH. Nothing is installed."}
        </span>
      </label>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium">Arguments</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!canEdit || draft.rows.length >= ACP_LOCAL_COMMAND_MAX_ARGS}
            onClick={() => publish({ rows: [...draft.rows, ...argumentRows([""])] })}
          >
            <PlusIcon className="size-3" />
            Add argument
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          One literal argument per row, in launch order. Quotes, variables, and globs are passed as
          typed.
        </p>
        {draft.rows.map((row, index) => (
          <div key={row.id} className="flex min-w-0 items-center gap-1.5">
            <CommandField
              commitOnChange={commitOnChange}
              aria-label={`Argument ${index + 1}`}
              maxLength={4096}
              value={row.value}
              disabled={!canEdit}
              autoComplete="off"
              spellCheck={false}
              onValueChange={(value) =>
                publish({
                  rows: draft.rows.map((current) =>
                    current.id === row.id ? { ...current, value } : current,
                  ),
                })
              }
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={!canEdit}
              aria-label={`Remove argument ${index + 1}`}
              onClick={() =>
                publish({ rows: draft.rows.filter((current) => current.id !== row.id) })
              }
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {!canEdit ? (
        <p className="text-xs text-muted-foreground">
          {hostedCapabilityCopy(capability, target?.nodeLabel) ??
            "Node management access and a current connection are required to change this command."}
        </p>
      ) : null}
    </div>
  );
}
