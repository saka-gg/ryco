/**
 * A start the phone could not make. `sent` says whether the machine may have
 * recorded it: a check made here (the task is gone or done) sent nothing; a
 * start the machine recorded as failed was sent, and goes again under the
 * same command, which the machine runs again.
 */
export class TaskChatStartError extends Error {
  readonly _tag = "TaskChatStartError";
  readonly sent: boolean;
  constructor(message: string, sent: boolean) {
    super(message);
    this.sent = sent;
  }
}

export function isTaskChatStartError(error: unknown): error is TaskChatStartError {
  return error instanceof TaskChatStartError;
}
