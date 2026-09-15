import { useEffect, useState, useSyncExternalStore } from "react";
import type { ProjectMemoryEntry } from "@ryco/contracts";
import type { ProjectMemoryController } from "@ryco/client-runtime/state/project-memory";
import {
  PROJECT_MEMORY_DELETION_NOTICE,
  projectMemoryNeedsReview,
  projectMemoryTextProblem,
} from "@ryco/shared/projectMemory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export function ProjectMemoryRecallPreview({
  controller,
}: {
  controller: ProjectMemoryController;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (!state.references.length) return null;
  return (
    <section
      aria-label="Selected project memory"
      className="space-y-2 rounded-lg border border-border p-3"
    >
      <p className="text-sm font-medium">
        {state.references.length} {state.references.length === 1 ? "memory" : "memories"} selected
        for this message
      </p>
      {!state.preview ? (
        <Button disabled={state.busy} onClick={() => void controller.previewRecall()}>
          Review selected memories
        </Button>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            These references will be checked again when your message is sent.
          </p>
          <ul className="space-y-3">
            {state.preview.entries.map((entry) => (
              <li key={entry.id} className="text-sm">
                <p className="whitespace-pre-wrap">{entry.text}</p>
                <MemoryProvenance entry={entry} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {state.preview.envelopeBytes.toLocaleString()} / 16,384 bytes · Quoted reference data
          </p>
        </>
      )}
    </section>
  );
}
function MemoryProvenance({ entry }: { entry: ProjectMemoryEntry }) {
  return (
    <p className="mt-1 break-all text-xs text-muted-foreground">
      {entry.kind} · User {entry.provenance.actorId.slice(0, 8)} · Saved{" "}
      {new Date(entry.createdAt).toLocaleDateString()} · Revision {entry.revision}
      {entry.provenance.source
        ? ` · Thread ${entry.provenance.source.threadId} · Message ${entry.provenance.source.messageId}`
        : " · Written by a user"}
    </p>
  );
}
export function ProjectMemoryPanel({ controller }: { controller: ProjectMemoryController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ProjectMemoryEntry["kind"]>("fact");
  const [editing, setEditing] = useState<ProjectMemoryEntry | null>(null);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<ProjectMemoryEntry | "all" | null>(null);
  useEffect(() => {
    void controller.refresh();
  }, [controller]);
  const save = async () => {
    const ok = await controller.mutate(
      editing
        ? { operation: "edit", id: editing.id, revision: editing.revision, kind, text }
        : { operation: "create", id: crypto.randomUUID(), kind, text },
    );
    if (ok) {
      setText("");
      setEditing(null);
    }
  };
  const download = async () => {
    const result = await controller.export();
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "project-memory.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section
      aria-label="Project memory"
      className="mx-auto max-w-3xl space-y-5 p-4 text-foreground"
    >
      <header>
        <h2 className="text-lg font-semibold">Project memory</h2>
        <p className="text-sm text-muted-foreground">
          Short facts you curate for this project on this node. Nothing is collected or recalled
          automatically.
        </p>
      </header>
      <p className="text-xs text-muted-foreground">
        Do not save credentials or private information. Recognized sensitive patterns are rejected;
        detection is not comprehensive.
      </p>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={state.busy || !state.page}
          onClick={() =>
            void controller.mutate({ operation: "enable", enabled: !state.page?.enabled })
          }
        >
          {state.page?.enabled ? "Disable memory" : "Enable memory"}
        </Button>
        <Button variant="outline" disabled={state.busy} onClick={() => void controller.refresh()}>
          Refresh
        </Button>
        <Button
          variant="outline"
          disabled={state.busy || !state.page}
          onClick={() => void download()}
        >
          Export JSON
        </Button>
        <Button
          variant="outline"
          disabled={state.busy || !state.page}
          onClick={() => setConfirm("all")}
        >
          Delete all and disable
        </Button>
        <span className="text-xs text-muted-foreground">
          {state.page?.total ?? 0} / 200 entries
        </span>
      </div>
      {state.page?.enabled && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block text-sm">
            Type
            <select
              aria-label="Memory type"
              value={kind}
              onChange={(event) => setKind(event.target.value as ProjectMemoryEntry["kind"])}
              className="ml-2 rounded border border-border bg-background p-2"
            >
              {["fact", "convention", "decision", "preference"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            {editing ? "Edit memory" : "New memory"}
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="One short project fact"
              className="mt-1"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {Array.from(text).length} / 500 characters · Unpinned entries need review after 90 days.
          </p>
          <Button type="submit" disabled={state.busy || projectMemoryTextProblem(text) !== null}>
            {editing ? "Save changes" : "Save memory"}
          </Button>
          {editing && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditing(null);
                setText("");
              }}
            >
              Cancel edit
            </Button>
          )}
        </form>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.refresh(query, 0);
        }}
      >
        <Input
          aria-label="Search memories"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={200}
        />
        <Button disabled={state.busy}>Search</Button>
      </form>
      {state.busy && (
        <p role="status" className="text-sm">
          Loading project memory…
        </p>
      )}
      {state.page && !state.page.entries.length && (
        <p className="text-sm text-muted-foreground">No memories found.</p>
      )}
      <ul className="divide-y divide-border">
        {state.page?.entries.map((entry) => {
          const expired = projectMemoryNeedsReview(entry, Date.parse(state.page!.asOf));
          return (
            <li key={entry.id} className="space-y-2 py-4">
              <p className="whitespace-pre-wrap text-sm">{entry.text}</p>
              <MemoryProvenance entry={entry} />
              <p className="text-xs text-muted-foreground">
                {entry.pinned ? "Pinned" : expired ? "Needs review" : "Current"}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={state.busy || !state.page?.enabled || expired}
                  aria-pressed={state.references.some((ref) => ref.id === entry.id)}
                  onClick={() => controller.toggleRecall(entry)}
                >
                  Select for recall
                </Button>
                <Button
                  variant="outline"
                  disabled={state.busy || !state.page?.enabled}
                  onClick={() => {
                    setEditing(entry);
                    setKind(entry.kind);
                    setText(entry.text);
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  disabled={state.busy || !state.page?.enabled}
                  onClick={() =>
                    void controller.mutate({
                      operation: "pin",
                      id: entry.id,
                      revision: entry.revision,
                      pinned: !entry.pinned,
                    })
                  }
                >
                  {entry.pinned ? "Unpin" : "Pin"}
                </Button>
                <Button
                  variant="outline"
                  disabled={state.busy || !state.page?.enabled}
                  onClick={() =>
                    void controller.mutate({
                      operation: "affirm",
                      id: entry.id,
                      revision: entry.revision,
                    })
                  }
                >
                  Still true
                </Button>
                <Button variant="outline" disabled={state.busy} onClick={() => setConfirm(entry)}>
                  Forget
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={state.busy || state.offset === 0}
          onClick={() => void controller.refresh(state.query, Math.max(0, state.offset - 50))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={state.busy || state.page?.nextOffset == null}
          onClick={() => void controller.refresh(state.query, state.page?.nextOffset ?? 0)}
        >
          Next
        </Button>
      </div>
      <ProjectMemoryRecallPreview controller={controller} />
      <p className="text-xs text-muted-foreground">{PROJECT_MEMORY_DELETION_NOTICE}</p>
      {confirm && (
        <section
          role="alertdialog"
          aria-label="Confirm memory deletion"
          className="space-y-2 rounded border border-destructive p-3"
        >
          <p className="text-sm">
            {confirm === "all"
              ? "Delete all saved memories and disable project memory?"
              : "Forget this saved memory?"}
          </p>
          <p className="text-xs">{PROJECT_MEMORY_DELETION_NOTICE}</p>
          <Button
            disabled={state.busy}
            onClick={() => {
              void controller
                .mutate(
                  confirm === "all"
                    ? { operation: "deleteAll" }
                    : { operation: "forget", id: confirm.id, revision: confirm.revision },
                )
                .then((ok) => {
                  if (ok) {
                    setConfirm(null);
                    setEditing(null);
                    setText("");
                  }
                });
            }}
          >
            Confirm deletion
          </Button>
          <Button variant="outline" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </section>
      )}
    </section>
  );
}
