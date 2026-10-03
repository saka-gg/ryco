import { Effect, Stream } from "effect";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

interface CollectState {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

interface TailState {
  readonly chunks: ReadonlyArray<Uint8Array>;
  /** Bytes held in `chunks`. */
  readonly held: number;
  /** Bytes the stream produced. */
  readonly seen: number;
}

/**
 * Keeps the last `maxBytes` of the stream (for logs, whose end is what
 * matters), holding at most `maxBytes` plus one chunk at a time. A cut start
 * is moved past UTF-8 continuation bytes so the text begins on a whole
 * character; `truncated` says the start was cut. No marker is added.
 */
const collectUint8StreamTail = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes: number;
}): Effect.Effect<CollectedUint8StreamText, E> =>
  input.stream.pipe(
    Stream.runFold(
      (): TailState => ({ chunks: [], held: 0, seen: 0 }),
      (state, chunk): TailState => {
        const chunks = [...state.chunks, chunk];
        let held = state.held + chunk.byteLength;
        // Drop whole chunks the window no longer needs.
        while (chunks.length > 1 && held - chunks[0]!.byteLength >= input.maxBytes) {
          held -= chunks.shift()!.byteLength;
        }
        return { chunks, held, seen: state.seen + chunk.byteLength };
      },
    ),
    Effect.map((state): CollectedUint8StreamText => {
      const joined = new Uint8Array(state.held);
      let offset = 0;
      for (const chunk of state.chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const truncated = state.seen > input.maxBytes;
      let start = Math.max(0, joined.byteLength - input.maxBytes);
      if (truncated) {
        while (start < joined.byteLength && ((joined[start] ?? 0) & 0xc0) === 0x80) start += 1;
      }
      const tail = joined.subarray(start);
      return { text: new TextDecoder().decode(tail), bytes: tail.byteLength, truncated };
    }),
  );

export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number | undefined;
  readonly truncatedMarker?: string | null | undefined;
  /** Keep the last `maxBytes` instead of the first (the marker is not used). */
  readonly keepTail?: boolean | undefined;
}): Effect.Effect<CollectedUint8StreamText, E> => {
  if (input.keepTail === true && input.maxBytes !== undefined && Number.isFinite(input.maxBytes)) {
    return collectUint8StreamTail({ stream: input.stream, maxBytes: Math.max(0, input.maxBytes) });
  }
  const decoder = new TextDecoder();
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedMarker = input.truncatedMarker ?? "";

  return input.stream.pipe(
    Stream.runFold(
      (): CollectState => ({
        text: "",
        bytes: 0,
        truncated: false,
      }),
      (state, chunk): CollectState => {
        if (state.truncated) {
          return state;
        }

        const remainingBytes = maxBytes - state.bytes;
        if (remainingBytes <= 0) {
          return {
            ...state,
            text: `${state.text}${truncatedMarker}`,
            truncated: true,
          };
        }

        const nextChunk =
          chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
        const text = `${state.text}${decoder.decode(nextChunk, { stream: true })}`;
        const bytes = state.bytes + nextChunk.byteLength;
        const truncated = chunk.byteLength > remainingBytes;

        return {
          text: truncated ? `${text}${truncatedMarker}` : text,
          bytes,
          truncated,
        };
      },
    ),
    Effect.map((state): CollectedUint8StreamText => ({
      text: state.truncated ? state.text : `${state.text}${decoder.decode()}`,
      bytes: state.bytes,
      truncated: state.truncated,
    })),
  );
};
