// Its own leaf module: the web app's lazily loaded plan helpers import it, and reaching the send
// engine from them would split the engine and its imports out of the shell's chunks into new files.

/** Starts the prompt that "Implement plan" sends, followed by the plan's markdown. */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";
