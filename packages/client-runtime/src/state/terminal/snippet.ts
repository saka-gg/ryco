import {
  TerminalInputRejectedError,
  type EnvironmentApi,
  type ScopedThreadRef,
} from "@ryco/contracts";

import { terminalSnippetError } from "@ryco/shared/terminalPaste";
export {
  MAX_TERMINAL_SNIPPET_BYTES,
  isTerminalSnippetLanguage,
  terminalSnippetError,
  bracketedTerminalSnippet,
} from "@ryco/shared/terminalPaste";

export interface TerminalSnippetTarget {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
}

export interface TerminalSnippetRequest {
  readonly target: TerminalSnippetTarget;
  readonly source: string;
  readonly isCurrent: () => boolean;
  readonly complete: (error?: Error) => void;
  readonly dispatched: boolean;
  readonly promise: Promise<void>;
  readonly dispatch: (inputEpoch: string, send: (source: string) => Promise<void>) => void;
}

const keyFor = (target: Pick<TerminalSnippetTarget, "threadRef" | "terminalId">) =>
  JSON.stringify([target.threadRef.environmentId, target.threadRef.threadId, target.terminalId]);

/** Ephemeral handoff to a real platform terminal. Never persist or replay input. */
export function createTerminalSnippetBroker() {
  const pending = new Map<string, TerminalSnippetRequest>();
  // Retain only identity evidence, never snippet content, for uncertain writes.
  const uncertain = new Map<string, { inputEpoch: string; token: object }>();
  // Even an acknowledged paste can still be waiting for the user's Enter.
  const pasted = new Map<string, { inputEpoch: string; token: object }>();
  const broker = {
    read: (target: Pick<TerminalSnippetTarget, "threadRef" | "terminalId">) =>
      pending.get(keyFor(target)),
    inputBlocked(
      target: Pick<TerminalSnippetTarget, "threadRef" | "terminalId">,
      inputEpoch?: string,
    ) {
      const key = keyFor(target);
      const delivery = pasted.get(key);
      if (delivery && inputEpoch && delivery.inputEpoch !== inputEpoch) {
        uncertain.delete(key);
        pasted.delete(key);
      }
      return pending.has(key) || uncertain.has(key);
    },
    async close(
      target: Pick<TerminalSnippetTarget, "threadRef" | "terminalId">,
      terminal: EnvironmentApi["terminal"],
      clearHistory: boolean,
    ) {
      const key = keyFor(target);
      const maySubmit = !pending.has(key) && !pasted.has(key);
      pending
        .get(key)
        ?.complete(
          new Error("Insertion cancelled because the terminal was closed. Nothing was sent."),
        );
      const delivery = pasted.get(key);
      const input = { threadId: target.threadRef.threadId, terminalId: target.terminalId };
      try {
        if (typeof terminal.close !== "function") throw new Error("Terminal close is unavailable.");
        // Preserve review evidence when delivery is uncertain.
        if (clearHistory && maySubmit) await terminal.clear(input).catch(() => undefined);
        await terminal.close({ ...input, deleteHistory: true });
        if (pasted.get(key) === delivery) {
          uncertain.delete(key);
          pasted.delete(key);
        }
      } catch (error) {
        // The ordinary compatibility fallback submits Enter and is unsafe for
        // any pane that could receive a delayed snippet.
        if (!maySubmit || pending.has(key) || pasted.has(key)) throw error;
        await terminal.write({ ...input, data: "exit\n" }).catch(() => undefined);
      }
    },
    request(target: TerminalSnippetTarget, source: string, isCurrent: () => boolean) {
      const error = terminalSnippetError(source);
      if (error) throw new Error(error);
      const key = keyFor(target);
      if (pending.has(key) || uncertain.has(key))
        throw new Error(
          "This terminal has a pending or unconfirmed insertion. Open a new terminal.",
        );
      let dispatched = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const token = {};
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const complete = (error?: Error) => {
        if (settled || pending.get(key) !== entry) return;
        settled = true;
        pending.delete(key);
        clearTimeout(timer);
        if (error)
          reject(
            dispatched && uncertain.get(key)?.token === token
              ? new Error(
                  "Snippet delivery is unconfirmed. It will not be retried. Input in this pane is blocked until delivery is confirmed; close this pane and open a new terminal to continue.",
                  { cause: error },
                )
              : error,
          );
        else resolve();
      };
      const entry: TerminalSnippetRequest = {
        target,
        source,
        isCurrent,
        complete,
        promise,
        get dispatched() {
          return dispatched;
        },
        dispatch(inputEpoch, send) {
          if (settled || dispatched || pending.get(key) !== entry) return;
          if (!isCurrent()) {
            complete(
              new Error(
                "Insertion cancelled because the thread or connection changed. Nothing was sent.",
              ),
            );
            return;
          }
          dispatched = true;
          const delivery = { inputEpoch, token };
          uncertain.set(key, delivery);
          pasted.set(key, delivery);
          clearTimeout(timer);
          timer = setTimeout(
            () => complete(new Error("Terminal write acknowledgment timed out.")),
            10_000,
          );
          const writeFailed = (error: unknown) => {
            if (error instanceof TerminalInputRejectedError) {
              if (uncertain.get(key)?.token === token) uncertain.delete(key);
              if (pasted.get(key)?.token === token) pasted.delete(key);
            }
            complete(error instanceof Error ? error : new Error(String(error)));
          };
          try {
            void send(source).then(() => {
              // A late ACK may release this epoch's input fence, but never settle
              // a newer request or trigger a late focus change.
              if (uncertain.get(key)?.token === token) uncertain.delete(key);
              if (!isCurrent())
                complete(new Error("Thread or connection changed during delivery."));
              else complete();
            }, writeFailed);
          } catch (error) {
            writeFailed(error);
          }
        },
      };
      timer = setTimeout(
        () =>
          complete(
            new Error(
              "Safe insertion is unavailable: the terminal did not become ready with bracketed paste. Nothing was sent.",
            ),
          ),
        10_000,
      );
      pending.set(key, entry);
      return {
        promise,
        cancel: () =>
          complete(
            new Error(
              "Insertion cancelled because the thread or terminal changed. Nothing was sent.",
            ),
          ),
      };
    },
  };
  return broker;
}
