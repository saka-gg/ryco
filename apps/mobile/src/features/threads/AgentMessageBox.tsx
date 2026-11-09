import { describeSubagentMessageFailure } from "@ryco/client-runtime/state/session/subagentMessage";
import { BACKGROUND_TASK_MESSAGE_MAX_CHARS } from "@ryco/contracts/orchestration";
import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

/** How long "Sent" stays before the hint comes back (web's 6 s). */
const SENT_NOTICE_MS = 6_000;

const HINT = "It reads your message at its next step; nothing stops.";

/**
 * A message to a running agent (web's `AgentMessageBox`): it lands at the agent's next step and
 * interrupts nothing. Shown on agents whose provider lets them read one.
 */
export function AgentMessageBox(props: {
  readonly agentLabel: string;
  readonly send: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textColor = useThemeColor("--color-foreground") as string;
  const placeholderColor = useThemeColor("--color-placeholder") as string;
  const primaryForeground = useThemeColor("--color-primary-foreground") as string;

  useEffect(() => {
    if (sentAt === null) return;
    const timer = setTimeout(() => setSentAt(null), SENT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [sentAt]);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !sending;
  const send = () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    void props.send(trimmed).then(
      () => {
        setText("");
        setSending(false);
        setSentAt(Date.now());
      },
      (cause: unknown) => {
        setSending(false);
        setError(describeSubagentMessageFailure(cause));
      },
    );
  };

  return (
    <View className="gap-1.5">
      <View className="flex-row items-end gap-2">
        <TextInput
          accessibilityLabel={`Message ${props.agentLabel}`}
          value={text}
          onChangeText={(value) => {
            setText(value);
            setError(null);
          }}
          placeholder="Message this agent…"
          placeholderTextColor={placeholderColor}
          multiline
          maxLength={BACKGROUND_TASK_MESSAGE_MAX_CHARS}
          editable={!sending}
          className="min-h-10 flex-1 rounded-2xl border border-border bg-screen px-3 py-2 font-sans text-sm"
          style={{ color: textColor, maxHeight: 120 }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send to agent"
          disabled={!canSend}
          onPress={send}
          className="h-10 w-10 items-center justify-center rounded-full bg-primary active:opacity-80 disabled:opacity-40"
        >
          <SymbolView name="arrow.up" size={15} tintColor={primaryForeground} type="monochrome" />
        </Pressable>
      </View>
      <Text className={`text-2xs ${error ? "text-danger-foreground" : "text-foreground-tertiary"}`}>
        {error ?? (sentAt !== null ? "Sent. The agent reads it at its next step." : HINT)}
      </Text>
    </View>
  );
}
