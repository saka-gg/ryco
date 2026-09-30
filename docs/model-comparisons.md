# Model comparisons

Compare one prompt across **two to four distinct provider/model/options selections** in a Git project. Each destination gets its own thread, branch and worktree. The same prompt, supported attachments and source-control context are sent to each selection; up to two destinations launch concurrently.

## Launch and review

1. Open a new task in a connected Git project with a base branch.
2. Choose a provider instance, model and effort/options in the model picker, then select **Compare models…**.
3. Change the picker and select **Add current selection**. Options count toward uniqueness, so the same model can be compared at different supported effort levels. Remove a selection by selecting its chip.
4. Write the prompt and send. Project branch-prefix, setup and checkout-root settings apply; each selected provider/model/options combination stays explicit. Submodule initialization follows the normal project/repository/node policy.
5. Use each result's **Open thread** and **Review** links on web, or **Open thread and review** on native. Web also offers **Split view**. Inspect each candidate's changes and its own test evidence before choosing a result.

Launch status describes delivery, separately from the provider's turn status. Diff and token figures come from reported thread evidence; unavailable figures remain unavailable. **Refresh evidence** can reconcile an uncertain launch with its original accepted user message even after later assistant responses.

## Retry and recovery

**Retry safe failures** retries only destinations that failed before dispatch. An explicit retry captures current connection readiness, node configuration and provider capabilities while retaining destination identities and selections. Launched or uncertain destinations are never resent. A lost acknowledgement remains uncertain until authoritative acceptance evidence is available; lack of evidence does not make retry safe.

**Stop remaining launches** stops queued/preparing work. It does not undo an accepted launch or resolve uncertain delivery. Once every destination is launched or cancelled, **Start another comparison** releases the source only after its completion marker is durably saved. A storage failure preserves the draft and launch evidence.

Web persists the delivery ledger, but its retry preparation snapshot is bound to the current composer session. Reconnect can retry safe failures in that session; a full reload retains delivery fences and result navigation but does not restore those retry ports. Native separately persists the source prompt, context and durable image bytes, allowing restart recovery and retries of pre-dispatch failures. Completed native sources receive fresh identities even if old draft deletion was interrupted.

## Requirements and limits

The node must advertise required-worktree bootstrap support. Capable nodes must also return effective project preferences successfully. Unsupported nodes, stale connection generations, unavailable selections and failed storage writes block launch.

Web requires **Web Locks** for atomic coordination across tabs sharing storage. Storage events refresh presentation; they do not authorize claims. Native uses the shared runtime's serialized storage operations.

The delivery ledger currently holds at most **128 comparisons** and **256 KiB**, with space reserved for unresolved outcomes. New comparisons are refused when either bound would be exceeded. Existing evidence and completed-source markers are retained; automatic pruning and an unlimited history are not supported. Native source drafts have a separate **32 MiB** storage bound. Recovery cannot compensate for externally deleted app storage.
