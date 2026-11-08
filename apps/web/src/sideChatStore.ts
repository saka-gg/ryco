import { createSideChatStore, type SideChatStore } from "@ryco/client-runtime/state/side-chat";

export const useSideChatStore: SideChatStore = createSideChatStore();

export const sideChatStore: SideChatStore = useSideChatStore;
