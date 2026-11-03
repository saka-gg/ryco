import {
  USER_INPUT_EXCHANGE_COPY,
  userInputExchangeCancelledLabel,
  type UserInputExchangeTimelineEntry,
} from "@ryco/client-runtime/state/session";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { threadMessagePresentation } from "./threadPresentation";

/**
 * An agent question the user answered: each question as a card on the agent's side and its
 * answer as a bubble on the user's side, the way the web transcript shows it. A cancelled
 * question keeps its card and says so.
 */
export function UserInputExchangeRow(props: { readonly exchange: UserInputExchangeTimelineEntry }) {
  const { exchange } = props;
  const question = threadMessagePresentation("assistant");
  const answer = threadMessagePresentation("user");
  return (
    <View className="gap-2 px-4 py-2">
      {exchange.questions.map((item) => (
        <View key={item.id} className="gap-2">
          <View
            accessibilityRole="text"
            className={`max-w-[88%] self-start rounded-[20px] px-4 py-3 ${question.bubbleClassName}`}
          >
            <Text className="text-2xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
              {item.header}
            </Text>
            <Text selectable className={`mt-1 font-sans text-base ${question.textClassName}`}>
              {item.question}
            </Text>
            {item.options.length > 0 ? (
              <Text className="mt-1 font-sans text-sm text-foreground-muted">
                {item.options.join(" · ")}
              </Text>
            ) : null}
          </View>
          {exchange.cancelled ? null : (
            <View
              accessibilityLabel={`${USER_INPUT_EXCHANGE_COPY.answerLabel}: ${
                item.answer ?? USER_INPUT_EXCHANGE_COPY.noAnswer
              }`}
              className={`max-w-[88%] self-end rounded-[20px] px-4 py-3 ${answer.bubbleClassName}`}
            >
              <Text selectable className={`font-sans text-base ${answer.textClassName}`}>
                {item.answer ?? USER_INPUT_EXCHANGE_COPY.noAnswer}
              </Text>
            </View>
          )}
        </View>
      ))}
      {exchange.cancelled ? (
        <Text className="text-2xs font-ryco-medium text-foreground-muted">
          {userInputExchangeCancelledLabel(exchange)}
        </Text>
      ) : null}
    </View>
  );
}
