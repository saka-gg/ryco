# Node updates

A node that runs as a background service (`ryco service install`, from an npm, bun or pnpm global
install) can update itself from the apps: the node's settings show the newest release on its
channel and an Update button. The desktop app's backend updates with the desktop app instead,
through its own updater, and is not covered here.

An update installs the exact release, checks that it starts on this node, and only then restarts
into it. A release that still fails to start is rolled back, with the database it migrated.

## From a terminal

`ryco update` starts the same update as the button, on this machine's node or, with
`--remote <name>`, on a paired one. It reads the node's state, shows the versions and asks before
the restart (`--yes` skips the question and is needed when the output is not a terminal), then
follows the run until the node reports how it ended after its restart. The node checks everything
itself, exactly as for the button: the newest release again, one update at a time, and the
installation and service it can restart. `ryco update --check` only shows where the node stands.

`--channel nightly` (or `latest`) moves a CLI node to another npm dist-tag. The node checks that
channel's newest release and refuses one that is not newer than what it runs: a channel switch
never downgrades. A node keeps following the channel of the release it runs, so a node on a
nightly moves back to stable with `--channel latest` once a stable release newer than its nightly
is out. The
desktop app follows its own channel instead (Ryco and Ryco Nightly are separate apps).

## What an update does

1. **Install.** The running node installs exactly the new release into the installation it runs
   from (npm into its own prefix, bun with the bun that runs it, pnpm into its global store).
2. **Preflight.** The running node copies the database with SQLite's `VACUUM INTO` (a consistent
   copy taken in one read transaction, so the server keeps writing; the database, WAL and index
   files are never copied by hand). It then runs the new release once as
   `ryco node-update-preflight --database <copy>`. The new release loads its whole server, native
   modules included (the terminal's PTY, SQLite, the Hub connector), sets up and migrates the copy
   exactly as it would the real database, and exits. It never listens, and never reads or writes
   the node's own state. The copy is deleted afterwards.
3. **Snapshot.** Right before the restart, the running node takes another `VACUUM INTO` copy:
   `<stateDir>/node-update/pre-<previous version>.sqlite`. Anything else in that directory goes
   first, so it holds one snapshot at most. Both copies need twice the database's size in free
   space; with less, the update stops before restarting.
4. **Restart.** The node writes the marker `<stateDir>/node-update.json`: the request, the previous
   version, the snapshot, and the exact command that reinstalls the previous release. Then it asks
   launchd or systemd to restart it.

A failed install, preflight or snapshot reinstalls the previous release, and the node keeps
running on it without a restart. The update then shows as failed, with the reason and the end of
the command's output.

A release from before the preflight does not know the subcommand. The new release prints a line
announcing the preflight before it loads anything, so output without that line comes from such a
release, and only then does the check fall back to `ryco --version`. A release that announces the
preflight and then crashes, hangs (10 minutes) or fails the migration fails the check.

`<stateDir>` is `~/.ryco/userdata` by default (`<base dir>/userdata` with `--base-dir` or
`RYCO_HOME`).

## After the restart

Before a service start of `ryco serve` loads the server, a small boot guard reads the marker. Each
start of the new release counts one attempt in it (written through a temporary file and a rename).
Once the node is ready, the server marks the marker ready, reports the update as succeeded and
removes the marker. Ready means:

- the database is migrated and the server's runtime is built,
- the server listens and serves requests,
- and, when the Hub connector is enabled, the connector is online (authenticated with the Hub).

The Hub wait is bounded to 2 minutes. A Hub outage is not the release's fault and must not roll it
back, so past that the node counts as ready all the same. A connector that waits for a person
(revoked, awaiting approval, a failure that needs an operator) ends the wait at once.

The third start of the new release without a ready node rolls the update back instead:

1. it reinstalls the previous release with the recorded command,
2. moves the new release's database (with its WAL) into `<stateDir>/node-update/`, as
   `failed-<new version>.sqlite`, and puts the snapshot in its place (nothing has the database
   open yet),
3. records the rollback in the marker and exits. The service manager starts the previous release,
   which reports the update as failed: "Ryco <new> did not finish starting (2 attempts), so the
   node rolled back to <previous> and restored the database from before the update."

If the reinstall fails, the database is left alone and the next three starts try again. After
that the guard lets the new release start as it would have without it. `ryco service restart`
counts as a start too. A release that hangs without ever exiting is not restarted by the service
manager, so it is not rolled back either; restart it.

Only the database and the release are rolled back. Settings and other files in the data directory
are not.

## What a rollback loses

The snapshot is the database at the moment its copy started. A rollback loses:

- what the previous release wrote after that moment: during the copy itself (a few seconds; about
  7 s for a 4.5 GB database) and in the second before the restart,
- what the new release wrote before it stopped. Its database is kept as
  `node-update/failed-<version>.sqlite` until the next update, for a look by hand.

The snapshot stays after a successful update, until the next update replaces it. It is an ordinary
SQLite database: to go back to it by hand, stop the node (`ryco service stop`), move
`state.sqlite` and its `-wal` and `-shm` files away, copy the snapshot to `state.sqlite`, and start
a Ryco release that supports its schema (see [database-backups.md](database-backups.md)).

## Out-of-memory kills (Linux)

The systemd unit sets `OOMPolicy=continue`: when the kernel's out-of-memory killer ends one process
of the unit (a provider CLI, or a build an agent runs), systemd keeps the node running instead of
stopping the whole unit. If the node itself is killed, `Restart=always` starts it again. Units
written by earlier releases get it with the next `ryco service install`.
