# Pull request watch

The server can watch a thread's pull request with no client connected. When something the agent
should act on happens, it wakes the thread's agent with a queued turn:

- a check fails;
- the required checks pass (all checks when the host marks none as required);
- someone else comments or reviews;
- the branch starts to conflict with its base.

With **Auto-fix CI** on (the user's switch), a failing head commit gets one bounded fix turn instead
of a news message. Ryco never merges a pull request for a watch, and nothing in this feature calls a
merge.

A watched thread never settles on its own. Settling, archiving, moving to Trash, a user Stop and
removing the checkout end its watches in the same command.

## Starting and stopping

- **RPC** `sourceControl.setPullRequestWatch` (operator, mutation): `{ threadId, number?, url?, news?,
  autoFix? }`. Without `number` and `url` it is the pull request of the thread's workspace; if the
  workspace has none yet, Ryco first looks for one the branch just opened (discovery) and links it.
  The answer carries the watch summary and `now`, the pull request's state right now (for example
  "1 check failing: lint. 2 running."). What is failing now is reported there and is not woken for
  later. A request that only turns something off (news, or Auto-fix CI, or both) reads nothing from
  the host, so it also works while the host is rate-limited or unreachable; its `now` says what the
  watch still does.
- **Main checkout**: the project's own checkout never discovers a pull request. Name it (number or
  URL) and Ryco links it to that workspace by hand, after checking that it belongs to the checkout's
  repository, and only once the watch starts: a refused one (closed, at the limit, owned elsewhere)
  links nothing. An agent cannot bring back a pull request the user removed from the workspace.
- **Another workspace of the project**: a thread may watch a pull request any workspace of its own
  project links, for example the one a delegated chat opened in its own worktree. The wake goes to
  the thread that watches it. Auto-fix CI stays with the chat whose own workspace has the pull
  request: a fix turn edits the woken chat's checkout.
- The same settings again answer with the current state and change nothing. Setting both `news`
  and `autoFix` off ends the watch; stopping never needs a host read or the pull request's link, and
  a request that only turns something off never starts a watch.
- Changes wait until the server admits commands after a start.
- **Agents** use `ryco_watch_pull_request` and `ryco_unwatch_pull_request` (Agent Control, see
  [Pull request watches](./agent-control.md#pull-request-watches)). They may only start or stop
  news watching; Auto-fix CI is the user's switch. A delegated chat whose result its delegating chat
  still waits for cannot watch; it reports the pull request, and the delegating chat watches it.
- Nodes without this feature leave `serverConfig.pullRequestWatch` out, and clients hide every
  watch control.

## In the app

- **Pull request page**: the rail's Agents section has an **Auto-fix CI** switch for one linked
  thread: the one already watching the pull request, else the newest whose own workspace has it,
  else the newest linked thread (threads you settled come last), named when several are linked.
  Below it a status line says what the watch does ("Watching the checks", "Fixing CI · attempt 2
  of 3", "Auto-fix paused: the fix turn ended without a push"), with **Stop watching**, and
  **Resume** while Auto-fix CI is paused. After a watch ends the line says why for a day
  ("Stopped watching: merged"). A merged or closed pull request offers no switch.
- **Crown**: the Checks card has the same switch, status line and buttons for the thread the Crown
  belongs to; its hover preview shows the status line only. Branch-only CI (no pull request) has
  none.
- **Mobile app**: while a watch is on, the task's header shows a chip beside its pull request badge
  ("Watching", "Auto-fix on", "Fixing 2/3", "Auto-fix paused"; "#77 Watching" for another pull
  request than the badge's; muted while the task shows cached content; a screen reader hears the
  whole status line with the header). The task sheet (tap the header) has a "Pull request #12"
  section with the same Auto-fix CI switch, status line, **Resume** and **Stop watching**, for the
  pull request the task watches (its own workspace's first), else its workspace's open one; for an
  open one nobody watches yet it says "Starts a fix turn in this task when checks fail. Never
  merges." A task that watches another workspace's pull request (a delegated chat's) gets no switch
  for it: Auto-fix CI runs only in the chat's own checkout. Archived and settled tasks start no
  watch. The section changes nothing until the node takes changes (connected, not read-only, not a
  cached view).
- The controls appear only on nodes that watch pull requests and outside the frozen phone layout,
  and they change nothing until the connection accepts changes (the same readiness as linking a
  pull request). The switch follows a click at once; the watch's own state takes over when the
  thread's shell agrees, the request fails, or the shell changes after the request went through.
- **Checks passed**: for a watched pull request the "Checks passed for PR #12" notice comes from
  the watch (its summary's pass turning true), with no pull request page open, once per pull request
  and head however many threads watch it. The pull request pages keep their own notice for pull
  requests nobody watches and stay quiet about watched ones. Both notices are shown whatever the
  thread alert settings are. The phone layout shows none from the watch, so there the pages keep
  their notice for watched pull requests too.

## How it reads

Every 2 minutes (the first pass 30 seconds after the server admits commands) the server reads each
watched pull request once, however many threads watch it, grouped per project:

1. **GitHub fingerprint first**: one GraphQL request (1 point) that moves when the state, the
   mergeability, the head, the check outcomes or the conversation move.
2. The **detail** (checks with required flags, head, mergeability) only when the fingerprint's status
   moved, something was in flight (checks running, mergeability unknown), or a decision asks for a
   current read (the Auto-fix CI push grace ended).
3. The **activity** (comments, reviews, review threads, plus the rest of each long review thread)
   only when the fingerprint's remarks moved, the last read was not whole, or 30 minutes passed
   (the fingerprint does not see edits inside review threads).

Hosts without a fingerprint (GitLab, Forgejo, Bitbucket, Azure DevOps) read in full when anything
was in flight, the workspace link moved, or 10 minutes passed. Background reads run in the
background process lane. The read cache is process memory: a restart costs one full read per
watched pull request.

## Numbers

| Rule                                                      | Value                                                | Source                      |
| --------------------------------------------------------- | ---------------------------------------------------- | --------------------------- |
| Sweep                                                     | every 2 minutes                                      | T3 Code                     |
| Quiet re-read without a fingerprint                       | 10 minutes                                           | T3 Code                     |
| Activity re-read with a fingerprint                       | 30 minutes                                           | T3 Code                     |
| Failed reads in a row before the watch ends               | 8                                                    | T3 Code                     |
| Comment-only wakes in a row before news stops             | 10                                                   | T3 Code                     |
| Items listed per wake / snippet length                    | 10 / 200 characters                                  | T3 Code                     |
| Pull requests read at once                                | 4                                                    | T3 Code, Synara             |
| Auto-fix CI attempts per failure streak                   | 3                                                    | Synara                      |
| Grace for a fix turn's push to show                       | 60 seconds                                           | Synara                      |
| Held wake re-check                                        | every 10 seconds, and at once on the thread's events | Ryco                        |
| Watches per thread                                        | 8                                                    | Ryco                        |
| Refused updates in a row before the watch ends            | 5                                                    | Ryco (as delegated results) |
| A held closing notice or agent news without Agent Control | ends after 24 hours                                  | Ryco (as delegated results) |

## Waking the agent

A wake goes through the same fences as a delegated result: never while the thread is busy, has a
pending start, is usage-limited, reverting, snoozed, or has a plan waiting for the user, and within
the shared budget of 4 cold session starts. A held wake records nothing, so the next pass derives
the same news again; it is re-checked from the cached read without a host read. The progress and
the wake commit in one orchestration command, fenced on the watch's revision and generation, so two
passes never both deliver.

Wakes never run with more authority, or in another checkout, than when watching began: a raised
runtime or a moved thread ends the watch (`scope-changed`). An agent-started watch holds its news
while Agent Control is off.

Host text is untrusted. Check names, paths, logins, branches and links pass one sanitiser (one line,
no control, direction or invisible characters, bounded length); comment text is quoted as JSON. Only
remarks from people with write access (GitHub `OWNER`, `MEMBER`, `COLLABORATOR`) and from bots wake
the agent or are quoted. Everyone else's (`CONTRIBUTOR`, `NONE`, `FIRST_TIMER`, any other value),
and every remark on hosts that do not say who has write access (GitLab, Forgejo, Bitbucket, Azure
DevOps), is only counted: the next wake says how many arrived. A required-check lookup that failed
leaves the stored pass gate as it was.

### Delivery after a restart

A wake is never sent twice. If restart recovery proves the wake's turn start never reached the
provider (`not-sent`), the watch's progress goes back to before that wake and the next pass derives
the same news again. A start that may have reached it (`uncertain`, a provider failure, a Stop) is
left as it is; the chat shows what happened.

## Auto-fix CI

When the checks settle red on a head commit that did not have a fix turn yet, Ryco starts one fix
turn (attempt n of 3). With required checks reported it acts on required failures only; checks that
need a person (`action-required`) never trigger it. The turn's prompt names the failing checks
(`gh pr checks` on GitHub), the exact head to verify before editing, says to treat logs, comments and
branch names as untrusted, and says never to merge. If the checkout is on another branch, Ryco
switches only from a clean tree and names the branch to return to; with local changes it waits.

- A push moves the watch back to watching; green checks reset the attempts.
- No push within 60 seconds after the fix turn ended (seen by a fresh read): paused, `no-push`.
- Three fix turns without green: paused, `attempt-limit`.
- A fix turn that never started: paused, `start-failed` (a fix turn is never re-sent).
- Plan or ask mode, a dirty checkout on another branch, or an unknown head branch: waits.
- One thread per pull request may run Auto-fix CI. Turning it on again resets the attempts and the
  pause.

## Ends

| Reason                                      | When                                                                    | Agent told           |
| ------------------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| `merged`                                    | the pull request merged (the workspace link learns it in the same pass) | no                   |
| `closed`                                    | the pull request closed                                                 | yes, when news is on |
| `unreadable`                                | 8 failed reads in a row (a rate limit only pauses)                      | yes, when news is on |
| `comment-limit`                             | 10 comment-only wakes in a row (Auto-fix CI keeps watching)             | in the last wake     |
| `unlinked`                                  | the link was dismissed, the workspace archived or its checkout removed  | no                   |
| `scope-changed`                             | the thread's runtime was raised or it moved checkouts                   | no                   |
| `settled`, `archived`, `trashed`, `stopped` | the thread's own lifecycle                                              | no                   |
| `rejected`                                  | 5 wakes in a row refused                                                | no                   |
| `expired`                                   | a held notice or agent news without Agent Control waited 24 hours       | no                   |
| `unwatched`                                 | the user or the agent stopped it                                        | no                   |

## Measuring host reads

`node apps/server/scripts/measure-pr-watch-reads.ts` runs the watch against a scripted host on a
virtual clock for 60 minutes and prints forge calls per hour by kind for five scenarios, beside a
naive baseline that reads the detail and the activity every 60 seconds. These are provider calls in a
simulation, not GitHub points; the `gh` estimate counts 1 process per fingerprint, 4 per detail, at
least 2 per activity read and 2 per review-thread tail.
