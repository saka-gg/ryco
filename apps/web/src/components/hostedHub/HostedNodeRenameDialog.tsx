import { useEffect, useState } from "react";

import type { HostedHubNode } from "../../hostedHub/types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

const MAX_NODE_NAME_LENGTH = 100;

export function HostedNodeRenameDialog({
  node,
  open,
  onOpenChange,
  onRename,
}: {
  readonly node: Pick<HostedHubNode, "label">;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRename: (label: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(node.label);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(node.label);
    setPending(false);
    setMutationError(null);
  }, [node.label, open]);

  const normalized = draft.trim();
  const validationError =
    normalized.length === 0
      ? "Enter a device name."
      : normalized.length > MAX_NODE_NAME_LENGTH
        ? "Use 100 characters or fewer."
        : null;
  const canSave = validationError === null && normalized !== node.label && !pending;

  const save = async () => {
    if (!canSave) return;
    setPending(true);
    setMutationError(null);
    try {
      await onRename(normalized);
      onOpenChange(false);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Unable to rename this device.");
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Rename device</DialogTitle>
          <DialogDescription>
            This is the canonical name shown to everyone authorized to use this device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <label htmlFor="hosted-node-name" className="text-sm font-medium">
            Device name
          </label>
          <Input
            id="hosted-node-name"
            value={draft}
            autoFocus
            disabled={pending}
            aria-invalid={validationError !== null || mutationError !== null}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setMutationError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canSave) void save();
            }}
          />
          {validationError ? <p className="text-xs text-destructive">{validationError}</p> : null}
          {mutationError ? (
            <p role="alert" className="text-xs text-destructive">
              {mutationError}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
