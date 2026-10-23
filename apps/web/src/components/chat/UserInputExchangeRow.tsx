import { memo } from "react";
import { MessageCircleQuestionMarkIcon } from "lucide-react";
import {
  USER_INPUT_EXCHANGE_COPY,
  userInputExchangeCancelledLabel,
  type UserInputExchangeTimelineEntry,
} from "@ryco/client-runtime/state/session";
import { type TimestampFormat } from "@ryco/contracts/settings";

import { formatTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";

/**
 * An agent question the user answered: each question as a card on the agent's side and its
 * answer as a bubble on the user's side. A cancelled question keeps its card and says so.
 */
export const UserInputExchangeRow = memo(function UserInputExchangeRow(props: {
  exchange: UserInputExchangeTimelineEntry;
  timestampFormat: TimestampFormat;
}) {
  const { exchange } = props;
  const timestamp = formatTimestamp(exchange.createdAt, props.timestampFormat);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-user-input-exchange={exchange.id}>
      {exchange.questions.map((question) => (
        <div key={question.id} className="flex min-w-0 flex-col gap-2">
          <div className="min-w-0 max-w-[80%] self-start rounded-2xl rounded-bl-sm border border-border/70 bg-card/70 px-3 py-2">
            <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground/60">
              <MessageCircleQuestionMarkIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate text-[11px] font-semibold tracking-widest uppercase">
                {question.header}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-foreground/90">
              {question.question}
            </p>
            {question.options.length > 0 ? (
              <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Options">
                {question.options.map((option) => (
                  <li
                    key={option}
                    className="rounded-md bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground/75"
                  >
                    {option}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {exchange.cancelled ? null : (
            <div className="flex min-w-0 max-w-[80%] flex-col items-end self-end">
              <p className="sr-only">{USER_INPUT_EXCHANGE_COPY.answerLabel}</p>
              <div className="rounded-2xl rounded-br-sm bg-foreground/8 px-3 py-2 shadow-md/5">
                <p
                  className={cn(
                    "whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed",
                    question.answer === null ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {question.answer ?? USER_INPUT_EXCHANGE_COPY.noAnswer}
                </p>
              </div>
            </div>
          )}
        </div>
      ))}
      <p
        className={cn(
          "text-[11px] text-muted-foreground/50",
          exchange.cancelled ? "text-left" : "text-right",
        )}
      >
        {exchange.cancelled
          ? `${userInputExchangeCancelledLabel(exchange)} · ${timestamp}`
          : timestamp}
      </p>
    </div>
  );
});
