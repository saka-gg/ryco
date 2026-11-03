/**
 * "called [Fix CI flakes]": the chat a heartbeat runs into. Typing narrows the
 * project's open chats on the schedule's device (the most recently active
 * first). Its items read like the branch list's: chat icon, title, check on
 * the right.
 */
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { ThreadId } from "@ryco/contracts";
import { CheckIcon, MessageSquareIcon } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../../../ui/combobox";
import { heartbeatChatMatches, type HeartbeatChat } from "../heartbeatChats.logic";
import { tokenAnchor, tokenPopupId } from "./tokenAnchor";

const CHAT_GAP = 6;
/** A token never wraps: a longer title is cut, and said whole in its label and tooltip. */
const TITLE_MAX = 40;

export function ChatToken(props: {
  readonly editorId: string;
  /** The chats it can run into (`heartbeatChatChoices`). */
  readonly chats: readonly HeartbeatChat[];
  /** The chosen chat, or null while one is being picked. */
  readonly value: ThreadId | null;
  /** What the token reads (`SentenceWords.chat`). */
  readonly display: string;
  readonly label: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The list finished closing (focus is back on the token, or nowhere if it hid). */
  readonly onClosed: () => void;
  readonly onPick: (threadId: ThreadId) => void;
  readonly onTokenKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { editorId, chats, open } = props;
  const [query, setQuery] = useState("");
  const titles = useMemo(
    () => new Map(chats.map((chat) => [chat.threadId as string, chat.title])),
    [chats],
  );
  const items = useMemo(() => chats.map((chat) => chat.threadId as string), [chats]);
  const filtered = useMemo(
    () =>
      query.trim()
        ? chats.filter((chat) => heartbeatChatMatches(chat, query.trim())).map((c) => c.threadId)
        : items,
    [chats, items, query],
  );
  const anchor = useMemo(() => tokenAnchor(editorId, "chat", CHAT_GAP), [editorId]);
  const cut = props.display.length > TITLE_MAX;
  const shown = cut ? `${props.display.slice(0, TITLE_MAX - 1).trimEnd()}…` : props.display;

  return (
    <Combobox
      items={items}
      filteredItems={filtered}
      autoHighlight
      open={open}
      value={props.value}
      onOpenChange={(next) => {
        props.onOpenChange(next);
        if (!next) setQuery("");
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
      onValueChange={(next) => {
        if (typeof next === "string" && next) props.onPick(next as ThreadId);
      }}
    >
      <ComboboxTrigger
        render={
          <button
            type="button"
            className="ae-tok"
            data-tok="chat"
            aria-label={props.label}
            title={cut ? props.display : undefined}
            onKeyDown={props.onTokenKeyDown}
          />
        }
      >
        {shown}
      </ComboboxTrigger>
      <ComboboxPopup
        anchor={anchor}
        align="start"
        sideOffset={CHAT_GAP}
        className="ae-ref-pop w-80"
        aria-label="Chat"
        data-ae-pop={tokenPopupId(editorId, "chat")}
      >
        <div className="border-b p-1">
          <ComboboxInput
            aria-label="Find a chat"
            className="rounded-md"
            inputClassName="ring-0"
            placeholder="Find a chat"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>
          {chats.length === 0 ? "No open chats in this project on this device." : "No chats match."}
        </ComboboxEmpty>
        <ComboboxList aria-label="Chats" className="max-h-64">
          {filtered.map((threadId, index) => (
            <ComboboxItem
              key={threadId}
              index={index}
              value={threadId}
              hideIndicator
              className="ae-ref-item"
              contentClassName="ae-ref-item-c"
            >
              <MessageSquareIcon aria-hidden="true" className="ae-ref-item-ic" />
              <span className="ae-ref-item-l">{titles.get(threadId)}</span>
              <ComboboxPrimitive.ItemIndicator className="ae-ref-item-ck">
                <CheckIcon aria-hidden="true" />
              </ComboboxPrimitive.ItemIndicator>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
