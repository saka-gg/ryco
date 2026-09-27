# Import local Codex and Claude conversations

In **Settings → this node → General → Import local conversations**, choose a source and find
conversations. The welcome tour's project step links to this screen. Select individual conversations,
choose an existing Ryco target project, and select an available provider/model for future turns.
A replacement project can be used when the original folder moved or no longer exists. Add a folder
through the normal project picker first if it is not already a Ryco project.

Discovery runs on the backend machine, including when settings are opened remotely. It is owner-only
and disabled on workspace-restricted servers because global provider archives can contain unrelated
project history. The frozen web phone tier is unchanged.

Sources are the backend's default `CODEX_HOME` (or `~/.codex`) and `CLAUDE_CONFIG_DIR` (or `~/.claude`).
The continuation instance must use that store. Custom instance homes and environment overrides are
not discoverable in this version. Codex shadow homes use the same authoritative home-layout resolver
and shared-session materialization as the Codex driver.

Search covers each bounded page's titles and source folders; **Search next page** continues the scan.
Discovery visits at most 10,000 directory entries and 2,000 transcript files, and reads at most 50
files / 32 MiB per page, checking a three-second budget between reads. Individual files are limited
to 16 MiB, records to 1 MiB, files to 20,000 records, and histories to 2,000 messages. Cached display metadata is invalidated
by file size, modification time and inode. Files exceeding limits, malformed UTF-8/JSON, incomplete
message chains and unfinished final turns are skipped with a visible count. No partial transcript is
silently imported. Source histories are never modified.

Imports show supported user and final assistant text in chronological order. Claude's selected
parent chain is followed through non-display records. Hidden reasoning, analysis/commentary channels,
unknown payloads, tools and attachments are not reconstructed. Recognizable API tokens, bearer tokens
and private keys are redacted from display text. The provider-native copy retains the provider's own
context; it is never sent to the browser as raw data. Archived Codex conversations stay archived.
Historical messages have distinct import IDs and completed legacy turn IDs, and a provenance activity
marks the boundary before new work.

Each conversation is forked before its Ryco thread is published. Codex uses `thread/read` and
`thread/fork` at a completed turn. Claude uses the installed SDK's `forkSession` in an isolated,
time-limited process, relocates only the newly created copy into the target project's native store,
and verifies `getSessionMessages` there. The SDK determines the project-directory key. Neither flow
submits a model turn. Future Ryco turns resume the copy, never the original source ID.

The durable import ledger pins the original project, provider configuration and source identity.
Completed retries never create another thread. Failed items show an error and can be retried using
**Import selected / retry failed**; successful items are excluded from the retry. Prepared operations
can restart safely, and a saved native copy is reused after an interrupted projection transaction.
Changing the pinned target or provider during retry is rejected.

## Recovery limits

If a process dies or times out inside a native fork before its new ID is saved, the external side
effect cannot be proven absent. The item is explicitly paused rather than automatically forked again;
only that item is quarantined. Possible orphan copies are excluded using Codex session metadata
`forked_from_id` and Claude SDK message `forkedFrom.sessionId` evidence. Other source histories
remain discoverable and importable. No provider files are deleted during recovery.
There is currently no in-app reconciliation action for this ambiguous state. A copy whose source
changed during forking is retained but not published as mismatched history. These states require
provider-history inspection and administrative recovery. Deleting a completed imported thread does
not reset its deduplication identity.

## Implementation references

- [Codex app-server](https://developers.openai.com/codex/app-server/): read, fork and resume APIs.
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions): independent forks.
- Installed Claude SDK TypeScript declarations: `forkSession`, `getSessionMessages`, `SessionKey`
  and `SessionStore`; synthetic tests exercise the installed SDK without an account or model request.
- [Synara v0.9.0 / v0.9.2](https://github.com/Emanuele-web04/synara) project import implementation and
  [changelog](https://www.trysynara.com/changelog) were reviewed as behavioral references. This
  implementation does not copy Synara code.
