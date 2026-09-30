import { createContext, useContext } from "react";

export const TerminalSnippetActionContext = createContext<
  ((source: string) => Promise<void>) | null
>(null);
export const useTerminalSnippetAction = () => useContext(TerminalSnippetActionContext);
