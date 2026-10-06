import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { fadeOpacity, onAnimationSettled, pickerEase, pickerMotionOn } from "./pickerMotion";

interface CrossfadeLayer {
  readonly id: number;
  readonly key: string;
  readonly tone: string | undefined;
  readonly content: ReactNode;
}

interface CrossfadeState {
  readonly current: CrossfadeLayer;
  readonly leaving: ReadonlyArray<CrossfadeLayer>;
}

/**
 * A text slot that crossfades when what it says changes (the When field's
 * chip, the preview's total): the new layer rises in over the old one, which
 * fades out. `layerKey` decides what counts as a change; the same key keeps
 * the current layer and only updates its content. Layers stack in one grid
 * cell (`.pk-xf`), so the slot never jumps. Under reduced motion the new
 * layer only fades. All layers share one keyed list, so the current layer
 * keeps its element (and any state inside it) when it starts leaving.
 */
export function Crossfade(props: {
  readonly layerKey: string;
  readonly tone?: string | undefined;
  readonly className?: string | undefined;
  readonly layerClassName?: string | undefined;
  readonly id?: string | undefined;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState<CrossfadeState>(() => ({
    current: { id: 0, key: props.layerKey, tone: props.tone, content: props.children },
    leaving: [],
  }));
  if (state.current.key !== props.layerKey) {
    setState({
      current: {
        id: state.current.id + 1,
        key: props.layerKey,
        tone: props.tone,
        content: props.children,
      },
      leaving: [...state.leaving, state.current],
    });
  }
  const hostRef = useRef<HTMLSpanElement>(null);
  const fadingRef = useRef(new Set<number>());

  const currentId = state.current.id;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || currentId === 0) return;
    const layer = host.querySelector<HTMLElement>(`[data-layer-id="${currentId}"]`);
    if (!layer) return;
    const moving = pickerMotionOn();
    layer.animate(
      moving
        ? [
            { opacity: 0, transform: "translateY(2px)" },
            { opacity: 1, transform: "none" },
          ]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration: moving ? 160 : 100, easing: pickerEase() },
    );
  }, [currentId]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    for (const old of state.leaving) {
      if (fadingRef.current.has(old.id)) continue;
      const element = host.querySelector<HTMLElement>(`[data-layer-id="${old.id}"]`);
      if (!element) continue;
      fadingRef.current.add(old.id);
      onAnimationSettled(fadeOpacity(element, 1, 0, 90), () => {
        fadingRef.current.delete(old.id);
        setState((current) => ({
          ...current,
          leaving: current.leaving.filter((layer) => layer.id !== old.id),
        }));
      });
    }
  }, [state.leaving]);

  return (
    <span ref={hostRef} className={props.className} id={props.id}>
      {[...state.leaving, state.current].map((layer) => {
        const leaving = layer !== state.current;
        return (
          <span
            key={layer.id}
            data-layer-id={layer.id}
            data-leaving={leaving ? "" : undefined}
            data-tone={leaving ? layer.tone : props.tone}
            aria-hidden={leaving || undefined}
            inert={leaving || undefined}
            className={cn("pk-xf", props.layerClassName)}
          >
            {leaving ? layer.content : props.children}
          </span>
        );
      })}
    </span>
  );
}
