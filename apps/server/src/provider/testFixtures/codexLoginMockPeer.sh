#!/usr/bin/env bash
# Wrapper so the isolated app-server can spawn the login mock peer: it always
# passes "app-server" as the first argument (real codex CLI subcommand);
# discard it and exec node on the .mjs peer.
shift
exec node "$(dirname "$0")/codexLoginMockPeer.mjs" "$@"
