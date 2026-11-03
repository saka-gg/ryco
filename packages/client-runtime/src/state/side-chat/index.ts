import { create } from "zustand";
import type {
  ModelSelection,
  SideQuestionInput,
  SideQuestionResult,
  ThreadId,
} from "@ryco/contracts";
import { quoteCitationsToPlainText } from "@ryco/shared/quoteCitations";

/**
 * The question a `/btw` prompt asks, or null when it is not one. Side's
 * question is plain text, which cannot show a chip: quote chips become
 * `[Quote N]` and quoted lines, so Side reads the quote and its comment.
 */
export function parseSideQuestionCommand(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? quoteCitationsToPlainText((match[1] ?? "").trim()) : null;
}

/** What "Continue as thread" says, on web and native alike. */
export const SIDE_CHAT_CONTINUE_COPY = {
  action: "Continue as thread",
  /** Shown in the fork dialog: where the side chat goes, and that nothing is sent. */
  seedNote: (count: number) =>
    `This side chat (${count === 1 ? "1 question" : `${count} questions`}) goes into the fork's composer as a draft. Nothing is sent until you send it.`,
  noReply: "There's no finished reply in this thread to continue from yet.",
} as const;

/**
 * The side chat as a ready-to-edit message for a thread that continues it: each question and its
 * answer as plain text, under a line that says where they come from, then a blank line to type
 * after. Only successful exchanges are side history, so a pending or failed question is left out.
 */
export function sideChatThreadSeed(
  exchanges: ReadonlyArray<{ readonly question: string; readonly answer: string }>,
): string {
  const pairs = exchanges.map(
    ({ question, answer }) => `Q: ${question.trim()}\nA: ${answer.trim()}`,
  );
  return `From a side chat about this thread:\n\n${pairs.join("\n\n")}\n\n`;
}

export interface SideChatApi {
  askSideQuestion(input: SideQuestionInput): Promise<SideQuestionResult>;
  cancelSideQuestion(input: { requestId: string }): Promise<unknown>;
}
export interface SideChat {
  readonly open: boolean;
  readonly draft: string;
  readonly modelSelection: ModelSelection;
  readonly exchanges: readonly { requestId: string; question: string; answer: string }[];
  readonly pending: { requestId: string; question: string } | null;
  readonly error: string | null;
  /** Retains failed input even when the user has already typed a newer draft. */
  readonly failedQuestion: string | null;
}
export interface SideChatState {
  readonly chatsByThreadKey: Readonly<Record<string, SideChat>>;
  open(key: string, modelSelection: ModelSelection, question?: string): void;
  close(key: string): void;
  /**
   * Minimizes an open side chat, else opens it (a new one with `modelSelection`). Returns whether
   * it is open now. Minimizing never stops a pending answer.
   */
  toggle(key: string, modelSelection: ModelSelection): boolean;
  setDraft(key: string, draft: string): void;
  restoreFailedQuestion(key: string): void;
  discardFailedQuestion(key: string): void;
  setModel(key: string, selection: ModelSelection): void;
  ask(
    key: string,
    input: { threadId: ThreadId; requestId: string; api: SideChatApi },
  ): Promise<void>;
  cancel(key: string): void;
  disconnect(key: string): void;
  clear(key: string): void;
}

/** Memory only. This store never dispatches primary commands or persists transcript data. */
export function createSideChatStore() {
  const requests = new Map<string, { requestId: string; api: SideChatApi }>();
  return create<SideChatState>((set, get) => {
    const update = (key: string, patch: Partial<SideChat>) =>
      set((state) => {
        const chat = state.chatsByThreadKey[key];
        return chat
          ? { chatsByThreadKey: { ...state.chatsByThreadKey, [key]: { ...chat, ...patch } } }
          : state;
      });
    const interrupt = (key: string, error: string | null, sendCancel = true) => {
      const request = requests.get(key);
      requests.delete(key); // Fence late success and failure before cancellation crosses the transport.
      const chat = get().chatsByThreadKey[key];
      if (chat?.pending)
        update(key, {
          pending: null,
          error,
          draft: chat.draft || chat.pending.question,
          failedQuestion: chat.draft ? chat.pending.question : null,
        });
      if (request && sendCancel)
        void request.api.cancelSideQuestion({ requestId: request.requestId }).catch(() => {});
    };
    return {
      chatsByThreadKey: {},
      open: (key, modelSelection, question) => {
        const chat = get().chatsByThreadKey[key];
        set((state) => ({
          chatsByThreadKey: {
            ...state.chatsByThreadKey,
            [key]: chat
              ? { ...chat, open: true, ...(question !== undefined ? { draft: question } : {}) }
              : {
                  open: true,
                  draft: question ?? "",
                  modelSelection,
                  exchanges: [],
                  pending: null,
                  error: null,
                  failedQuestion: null,
                },
          },
        }));
      },
      close: (key) => update(key, { open: false }),
      toggle: (key, modelSelection) => {
        if (get().chatsByThreadKey[key]?.open) {
          get().close(key);
          return false;
        }
        get().open(key, modelSelection);
        return true;
      },
      setDraft: (key, draft) => update(key, { draft }),
      restoreFailedQuestion: (key) => {
        const chat = get().chatsByThreadKey[key];
        if (!chat?.failedQuestion) return;
        update(key, {
          draft: [chat.draft, chat.failedQuestion].filter(Boolean).join("\n\n"),
          failedQuestion: null,
        });
      },
      discardFailedQuestion: (key) => update(key, { failedQuestion: null }),
      setModel: (key, modelSelection) => update(key, { modelSelection }),
      ask: async (key, { threadId, requestId, api }) => {
        const chat = get().chatsByThreadKey[key];
        const question = chat?.draft.trim();
        if (!chat || !question || chat.pending || chat.failedQuestion) return;
        const request = { requestId, api };
        requests.set(key, request);
        update(key, { pending: { requestId, question }, draft: "", error: null });
        try {
          const result = await api.askSideQuestion({
            threadId,
            requestId,
            question,
            history: chat.exchanges.map(({ question, answer }) => ({ question, answer })),
            modelSelection: chat.modelSelection,
          });
          if (requests.get(key) !== request) return;
          if (result.requestId !== requestId)
            throw new Error("Side chat response did not match its request.");
          update(key, {
            pending: null,
            exchanges: [...chat.exchanges, { requestId, question, answer: result.answer }],
          });
        } catch (error) {
          if (requests.get(key) !== request) return;
          update(key, {
            pending: null,
            draft: get().chatsByThreadKey[key]?.draft || question,
            failedQuestion: get().chatsByThreadKey[key]?.draft ? question : null,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (requests.get(key) === request) requests.delete(key);
        }
      },
      cancel: (key) => interrupt(key, "Side question cancelled."),
      // A disconnected transport may queue requests onto a new socket. The server owns
      // socket-close cleanup, so fence locally without sending cancellation across generations.
      disconnect: (key) => interrupt(key, "Connection lost. Ask again after reconnecting.", false),
      clear: (key) => {
        interrupt(key, null);
        update(key, { exchanges: [], pending: null, error: null, draft: "", failedQuestion: null });
      },
    };
  });
}
