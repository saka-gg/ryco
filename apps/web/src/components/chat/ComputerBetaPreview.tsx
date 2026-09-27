import { useEffect, useRef, useState } from "react";
import type { ComputerBetaState, ComputerBetaUpdate } from "@ryco/contracts";
import {
  MonitorIcon,
  MoveIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
  SquareIcon,
  PanelBottomIcon,
} from "lucide-react";
import { Button } from "../ui/button";

interface PreviewPresentation {
  hidden: boolean;
  large: boolean;
  docked: boolean;
  position: { x: number; y: number };
}
const presentations = new Map<string, PreviewPresentation>();
const presentationId = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);

/** View-only local pixels. This component has no input forwarding or model attachment path. */
export function ComputerBetaPreview({ threadId }: { threadId: string }) {
  const api = window.desktopBridge?.computerBeta;
  const [state, setState] = useState<ComputerBetaState | null>(null);
  const [task, setTask] = useState<{ turnId: string; targetId?: string; label: string } | null>(
    null,
  );
  const [hidden, setHidden] = useState(false);
  const [large, setLarge] = useState(false);
  const [docked, setDocked] = useState(false);
  const [position, setPosition] = useState({ x: 16, y: 64 });
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState("Waiting for an exact window or browser tab…");
  const [error, setError] = useState<string | null>(null);
  const retired = useRef(new Set<string>());
  const current = useRef<{ turnId: string; targetId?: string } | null>(null);
  const url = useRef<string | null>(null);
  const preference = useRef<ComputerBetaState | null>(null);
  const dragging = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const restorePresentation = (
      turnId: string,
      preferences: ComputerBetaState["preferences"] | undefined,
    ) => {
      const saved = presentations.get(presentationId(threadId, turnId));
      setHidden(saved?.hidden ?? preferences?.autoPreview === false);
      setLarge(saved?.large ?? preferences?.previewSize === "large");
      setDocked(saved?.docked ?? false);
      setPosition(saved?.position ?? { x: 16, y: 64 });
    };
    const clearFrame = () => {
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      setFrame(null);
    };
    void api
      .getState()
      .then((value) => {
        if (mounted) {
          setState(value);
          preference.current = value;
          const target = value.targets?.find((item) => item.threadId === threadId);
          if (target && !current.current && !retired.current.has(target.turnId)) {
            current.current = target;
            setTask(target);
            restorePresentation(target.turnId, value.preferences);
          }
        }
      })
      .catch(() => undefined);
    const receive = (update: ComputerBetaUpdate) => {
      if (update.type === "state") {
        setState(update.state);
        preference.current = update.state;
        return;
      }
      if (update.type === "event") {
        if (
          update.event.type === "computer.thread-state" &&
          update.event.state.threadId === threadId
        ) {
          const value = update.event.state;
          setStatus(
            value.inputPause?.message ??
              value.lastError ??
              (value.sharedPreviewUnavailable
                ? "Preview paused while another task is using this computer"
                : value.agentActive
                  ? "Working · view only"
                  : "Waiting for the next action"),
          );
        }
        return;
      }
      if (update.threadId !== threadId || retired.current.has(update.turnId)) return;
      if (update.type === "ended") {
        retired.current.add(update.turnId);
        presentations.delete(presentationId(threadId, update.turnId));
        if (retired.current.size > 64)
          retired.current.delete(retired.current.values().next().value!);
        if (current.current?.turnId !== update.turnId) return;
        current.current = null;
        setTask(null);
        clearFrame();
        return;
      }
      if (update.type === "error") {
        setError(update.message);
        return;
      }
      if (current.current?.turnId !== update.turnId) {
        current.current = { turnId: update.turnId };
        clearFrame();
        setError(null);
        restorePresentation(update.turnId, preference.current?.preferences);
      }
      if (current.current.targetId !== update.targetId) {
        current.current = { turnId: update.turnId, targetId: update.targetId };
        clearFrame();
        setError(null);
        setStatus("Waiting for an exact window or browser tab…");
      }
      if (update.type === "target")
        setTask({ turnId: update.turnId, targetId: update.targetId, label: update.label });
      if (update.type === "frame") {
        setStatus((previous) =>
          previous.startsWith("Waiting for an exact") ? "Live preview · view only" : previous,
        );
        const next = URL.createObjectURL(
          new Blob([new Uint8Array(update.bytes)], { type: update.mimeType }),
        );
        const previous = url.current;
        url.current = next;
        setFrame(next);
        if (previous) URL.revokeObjectURL(previous);
        setTask((old) => ({
          turnId: update.turnId,
          targetId: update.targetId,
          label: old?.label ?? "Computer",
        }));
      }
    };
    const unsubscribe = api.onUpdate(receive);
    return () => {
      mounted = false;
      unsubscribe();
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      void api.setPreview(threadId, false).catch(() => undefined);
    };
  }, [api, threadId]);
  const presentationKey = task ? presentationId(threadId, task.turnId) : null;
  useEffect(() => {
    if (!presentationKey) return;
    presentations.delete(presentationKey);
    presentations.set(presentationKey, { hidden, large, docked, position });
    while (presentations.size > 64) presentations.delete(presentations.keys().next().value!);
  }, [presentationKey, hidden, large, docked, position]);
  const previewActive = task !== null;
  useEffect(() => {
    if (!api) return;
    const update = () =>
      void api
        .setPreview(threadId, previewActive && !hidden && document.visibilityState === "visible")
        .catch(() => undefined);
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      void api.setPreview(threadId, false).catch(() => undefined);
    };
  }, [api, threadId, previewActive, hidden]);
  if (!api || !task || state?.supported === false) return null;
  if (hidden)
    return (
      <Button
        className="absolute right-4 top-16 z-20"
        variant="outline"
        size="sm"
        onClick={() => setHidden(false)}
      >
        <MonitorIcon className="size-3" />
        Show Computer
      </Button>
    );
  return (
    <section
      aria-label="Computer preview"
      className={`${docked ? "relative mx-4 mt-3" : "absolute z-30"} overflow-hidden rounded-xl border bg-background shadow-xl`}
      style={
        docked
          ? {}
          : {
              left: position.x,
              top: position.y,
              width: large ? "min(720px, calc(100% - 32px))" : "min(384px, calc(100% - 32px))",
              maxHeight: "calc(100% - 80px)",
            }
      }
    >
      <header className="flex items-center gap-1 border-b px-2 py-1.5">
        <button
          aria-label="Move preview"
          className="cursor-grab touch-none p-1"
          onPointerDown={(event) => {
            if (docked) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragging.current = {
              x: event.clientX,
              y: event.clientY,
              left: position.x,
              top: position.y,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragging.current;
            if (!drag) return;
            const parent = event.currentTarget.closest("section")?.parentElement;
            setPosition({
              x: Math.max(
                0,
                Math.min(
                  (parent?.clientWidth ?? window.innerWidth) -
                    (event.currentTarget.closest("section")?.clientWidth ?? 384),
                  drag.left + event.clientX - drag.x,
                ),
              ),
              y: Math.max(
                0,
                Math.min(
                  (parent?.clientHeight ?? window.innerHeight) -
                    (event.currentTarget.closest("section")?.clientHeight ?? 300),
                  drag.top + event.clientY - drag.y,
                ),
              ),
            });
          }}
          onPointerUp={() => {
            dragging.current = null;
          }}
          onPointerCancel={() => {
            dragging.current = null;
          }}
        >
          <MoveIcon className="size-3" />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.label}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={docked ? "Float preview" : "Dock preview"}
          onClick={() => setDocked(!docked)}
        >
          <PanelBottomIcon className="size-3" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={large ? "Compact preview" : "Expand preview"}
          onClick={() => setLarge(!large)}
        >
          {large ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Hide preview"
          onClick={() => setHidden(true)}
        >
          <XIcon className="size-3" />
        </Button>
      </header>
      <div className="flex min-h-32 items-center justify-center bg-black/5">
        {frame ? (
          <img
            src={frame}
            alt="Live view of the agent's current target"
            draggable={false}
            className="max-h-[55vh] w-full object-contain pointer-events-none"
          />
        ) : (
          <p className="p-6 text-center text-xs text-muted-foreground">{status}</p>
        )}
      </div>
      <footer className="flex items-center gap-2 border-t px-3 py-2">
        <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
          {error ?? status}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void api
              .stopTask(threadId)
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Could not stop Computer."),
              )
          }
        >
          <SquareIcon className="size-3" />
          Stop
        </Button>
      </footer>
    </section>
  );
}
