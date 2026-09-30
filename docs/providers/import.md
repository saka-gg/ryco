# Import local Codex and Claude conversations

In **Settings → this node → General → Import local conversations**, choose a source and find
conversations. The welcome tour's project step links to this screen. Select individual conversations,
choose an existing Ryco target project, and select an available provider/model for future turns.
A replacement project can be used when the original folder moved or no longer exists. Add a folder
through the normal project picker first if it is not already a Ryco project. Targets must be existing
canonical directories; linked target paths are refused so native continuation uses the same project
store on later turns.

Discovery runs on the backend machine, including when settings are opened remotely. It is owner-only
and disabled on workspace-restricted servers because global provider archives can contain unrelated
project history.

Choose a **Source store** explicitly. Available stores are the backend's default `CODEX_HOME`
(or `HOME/.codex`) and `CLAUDE_CONFIG_DIR` (or `HOME/.claude`), plus Codex/Claude provider-instance
stores declared in node settings. Discovery scans only the chosen store's session directories;
it never searches arbitrary home directories. At most 128 source declarations are resolved.
Canonical path aliases, defaults and disabled declarations are deduplicated. Disabled instances
can declare a discoverable store, but cannot continue an import. Missing or invalid declarations
are omitted. Only enabled, installed, available continuation instances using the selected canonical
store are offered; models remain restricted to that instance's available catalog.

Codex resolves `homePath` before the instance/process `CODEX_HOME`, then `HOME/.codex`.
Its `shadowHomePath` is an authentication overlay: discovery and continuation matching use the
shared history home, with the same authoritative layout resolver and materialization as the driver.
Claude resolves `CLAUDE_CONFIG_DIR` before `.claude` under its configured `homePath` or effective
`HOME`. Instance environment variables are merged with the backend environment in the same order
as the provider driver. Relative home/store declarations are resolved before the provider enters
the project folder. Linked archive directories and transcript files are not traversed.
Runtime, import discovery and storage cleanup share a pure source-path parser. Cleanup protection
additionally retains legacy/default histories, disabled instances, Codex shadow/archive paths,
Claude history layouts, OpenCode database sidecars and configured Cursor exports. Import discovery
can therefore offer a smaller set of continuation-capable stores without narrowing cleanup protection.
The web importer is available on desktop/tablet presentation; there is no native importer screen yet.
The frozen web phone tier is unchanged.

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
restart directly from their pinned command and source store, even when a retry omits its store key.
A returned native identity is saved before further verification, so an interrupted operation retries
that exact copy. Every copy, including a normal successful fork, passes the same source, native
provenance/completeness and file-fingerprint checks before publication. Older unpublished ledger
rows lacking copy evidence are verified and upgraded conservatively; they are never automatically
forked again. Changing the pinned source, copy, target, store or provider blocks publication.

Publication admission runs in the orchestration queue. It revalidates the pinned state after queued
project changes and serializes with settings writes/reloads. Binding and history projection share
a SQL transaction; an admission failure rolls both back and leaves the command receipt retryable.
Native verification runs before this short transaction. Completed retries preserve the current
runtime cursor and do not require the original archives to remain available.

## Recovery limits

If a process dies or times out inside a native fork before its new ID is saved, the external side
effect cannot be proven absent. The item is explicitly paused rather than automatically forked again;
only that item is quarantined. Possible orphan copies are excluded using Codex session metadata
`forked_from_id` and Claude SDK message `forkedFrom.sessionId` evidence. Other source histories
remain discoverable and importable. No provider files are deleted during recovery.
Owners can choose **Inspect existing copies** on a quarantined source. Inspection uses the pinned
canonical store, source fingerprint, provider configuration and target project. **Inspect next page**
continues a bounded scan (50 files / 32 MiB per page, the same file/record/message and three-second
between-read budgets as discovery). The pinned-source read counts toward the page allowance.
Native verification moves to the next page when it would exceed the remaining read/byte budget.
A complete, unchanged, uncapped scan must prove exactly one
candidate. The UI shows at most eight native session IDs and message counts, never raw transcripts,
provider context, credentials, or arbitrary path/ID inputs. Inspection receipts are bounded to 32
process-local scans and expire after ten minutes; restart or expiry requires inspection again.
Expiration never proves that a fork is absent.

**Adopt proven copy** is offered only after the server verifies independent candidate identity,
`forked_from_id` / `forkedFrom.sessionId` provenance, unchanged provider-native message context,
and completeness in the pinned native target store. Codex also verifies its effective app-server
home, thread ID, rollout path, cwd and completed full native turns through `thread/read`.
Claude asks the installed SDK for the target's project key and verifies `getSessionMessages` there.
A copy interrupted before Claude relocation remains paused; reconciliation does not relocate it.
No recovery action creates another fork, deletes provider files, or submits a model turn.

Zero, multiple, unreadable, incomplete, capped, linked, changed or mismatched candidates leave the import
paused. Even an unreadable unrelated file prevents a uniqueness proof because it could hide another
fork. Changed source contents, settings, store aliases or target folders require restoring the pinned
state and inspecting again. Compatibility checks are conservative: a fork whose native context no
longer matches the original cannot be adopted. There is no manual override for ambiguous evidence.

Adoption rechecks the evidence, atomically saves the copy's ID, file and fingerprint in the durable
ledger, then uses the existing import publication path. Concurrent owners and repeated adoption reuse
the saved copy and command receipt. After a crash before publication, retry verifies the saved copy
again; after publication it preserves the thread's current runtime cursor. If adoption reports an
interrupted publication, find conversations again and use **Import selected / retry failed** with the
original selection. A copy whose source changed during the initial fork is also retained but not
published as mismatched history. These cases remain paused until the pinned source is restored.
Deleting a completed imported thread does not reset its deduplication identity.

## Implementation references

- [Codex app-server](https://developers.openai.com/codex/app-server/): read, fork and resume APIs.
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions): independent forks.
- Installed Claude SDK TypeScript declarations: `forkSession`, `getSessionMessages`, `SessionKey`
  and `SessionStore`; synthetic tests exercise the installed SDK without an account or model request.
- [Synara v0.9.0 / v0.9.2](https://github.com/Emanuele-web04/synara) project import implementation and
  [changelog](https://www.trysynara.com/changelog) were reviewed as behavioral references. This
  implementation does not copy Synara code.
