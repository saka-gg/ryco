# Insert conversation snippets in a terminal

Completed `shell`, `bash`, `sh`, and `zsh` message code blocks offer **Insert in
terminal** on desktop web and the desktop app. The action opens a new terminal
pane in that message's owning node and thread, using its current project or
worktree directory. Existing panes and unfinished input are preserved. Review
the inserted snippet and press **Enter in the terminal** to execute it.

Insertion does not submit Enter, run a provider turn, clear terminal input, or
retry an ambiguous write. It preserves the complete logical code-block content,
including Unicode, indentation, internal line endings and trailing blank lines.
The display newline added by the markdown renderer is excluded. Original CRLF
bytes are retained when they match the parser's logical code content.

Safe insertion requires a running, fresh terminal whose shell has advertised
bracketed paste. Shells without that support refuse insertion after ten seconds;
there is no raw multiline-paste fallback. Empty snippets, snippets above 48 KiB
in UTF-8, incomplete fences and terminal control characters are excluded or
refused. Streaming blocks offer copy only. The frozen web phone presentation
does not expose this action. Native mobile does not currently expose this
guarded insertion capability.

The renderer shares its code-block action boundary with the conversation. An
ephemeral shared-runtime broker hands the snippet to the exact platform terminal
by node, thread and terminal ID. Snippets are never persisted or replayed after
reconnect. The handoff checks pane ownership, connection snapshot evidence,
hosted authorization and node mutation lease, and current workspace state.
Keyboard and paste input are blocked during the brief handoff so an early Enter
cannot submit the snippet. Readiness and write acknowledgment each have a ten-second
deadline. Cancellation, teardown and reconnect also settle the action while a
write is awaiting acknowledgment. An uncertain write is never retried. Its pane
shows a delivery warning and blocks input until a late successful acknowledgment
or a different PTY input epoch confirms that manual input is safe. Close the pane
and open a new terminal to continue immediately; other panes remain usable.
Confirmed server rejection or closure also releases the input fence. Closing a
pane that received a snippet never uses the legacy `exit` plus Enter fallback.

The existing owner-authorized terminal RPCs enforce current workspace admission.
Guarded writes carry the PTY input epoch and the cursor of the output actually
parsed by the terminal. The server rejects changed sessions, pending or newer
output, missing directories, running subprocesses and any prior input, and
validates the complete bracketed-paste envelope without an Enter outside it. The final check and write
are synchronous under the terminal lifecycle lock. Orchestration supplies a
synchronous workspace revision fence, invalidated before workspace persistence
and checked beside the PTY write after queueing and filesystem admission. A
change back to the original directory still invalidates the earlier insertion.
This fence requires no lock around filesystem work. Older servers without input
epochs refuse insertion. Ordinary manual terminal input retains its existing
behavior.

Full-screen terminal applications also refuse insertion. A PTY restart cancels
an unfinished handoff, and a late write acknowledgment cannot take focus from a
different thread. If an existing transitional launch context does not yet match
the current workspace, insertion refuses until that context settles.
