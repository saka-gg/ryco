import { create } from "zustand";
import type {
  ModelSelection,
  SideQuestionInput,
  SideQuestionResult,
  ThreadId,
} from "@ryco/contracts";

export function parseSideQuestionCommand(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? "").trim() : null;
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
}
export interface SideChatState {
  readonly chatsByThreadKey: Readonly<Record<string, SideChat>>;
  open(key: string, modelSelection: ModelSelection, question?: string): void;
  close(key: string): void;
  setDraft(key: string, draft: string): void;
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
        update(key, { pending: null, error, draft: chat.draft || chat.pending.question });
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
                },
          },
        }));
      },
      close: (key) => update(key, { open: false }),
      setDraft: (key, draft) => update(key, { draft }),
      setModel: (key, modelSelection) => update(key, { modelSelection }),
      ask: async (key, { threadId, requestId, api }) => {
        const chat = get().chatsByThreadKey[key];
        const question = chat?.draft.trim();
        if (!chat || !question || chat.pending) return;
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
        update(key, { exchanges: [], pending: null, error: null, draft: "" });
      },
    };
  });
}
