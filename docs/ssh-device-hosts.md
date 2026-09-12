# Simulator hosts over SSH

A Ryco coding node can drive simulators on multiple Macs, including when the coding
node runs Linux. Select a simulator in the existing Simulator picker: remote entries
include the host name. Each thread still selects one device; different threads can
stream different devices concurrently. Host configuration belongs to the coding node,
not to the browser or the computer displaying it.

Install the same Ryco version on the Mac and the coding node. The Mac needs Xcode,
an installed iOS runtime, accepted Xcode licenses, and the existing Ryco native helper
requirements. The SSH account needs access to that Mac's simulator session. No remote
package installation happens automatically. The executable must also find its Node
runtime in the non-interactive SSH environment.

Create a node-local JSON file and start Ryco with `RYCO_DEVICE_HOSTS_FILE` pointing to
its absolute path:

```json
[
  {
    "name": "Simulator Mac",
    "target": "simulator-mac",
    "executable": "/opt/homebrew/bin/ryco"
  }
]
```

`target` can be an SSH config alias or `user@hostname`. Optional `port` and
`identityFile` (an absolute path on the coding node) override SSH defaults. Establish
SSH access and trust the Mac's host key with your normal SSH client first. Ryco uses
batch authentication, strict host-key checking, and the coding node's SSH configuration
and key agent. It disables agent/X11 forwarding and configured port forwards. The
configuration contains paths, not private key material. Up to 16 SSH hosts and 256
devices across all hosts are supported. Restart the coding node after adding, editing,
or removing hosts. Removing a host does not uninstall Ryco on the Mac.

Host identity is a fingerprint of the SSH target, port, key path and executable path.
Renaming a host preserves device selections; changing its destination gives it new
identities. Treat SSH aliases as stable destinations: retargeting an alias is an SSH
configuration change requiring the same care as changing any trusted remote host.
Native simulator IDs are retained as metadata, while every RPC, attachment, frame
subscription and boot record uses the host-qualified ID. Identical simulator IDs on
different Macs cannot route to each other. Local simulator IDs remain unchanged.

Discovery, boot/shutdown, input, app launch, deep links, screenshots and video use a
bounded stdio protocol over SSH. A matching protocol and Ryco package version are
required before an operation is sent. SSH app delivery is not supported: install the built `.app` bundle on the Mac first,
then launch it by bundle ID. Existing project-artifact approvals remain scoped to the
coding node's filesystem; they never authorize a different artifact at the same path
on a remote Mac. This does not transfer build outputs or forward Metro/dev-server ports. Saved screenshots and recordings on
SSH hosts are currently refused so remote paths cannot be mistaken for coding-node
artifacts; screenshots without `save` return PNG bytes normally.

The existing device manager retains the global Ryco boot cap, thread attachments,
agent authorization, owner-only mutations and user-boot preservation. There are no new
browser credentials, hosted lifecycle owners, public device endpoints or provider
tool grants. The remote worker uses the same boot policy and stores its crash recovery
record on the Mac. It releases only its own boots after EOF, heartbeat expiry or exit,
and waits for an already executing boot before cleanup. Each device has a separate
native helper binding, avoiding cross-device input or stream replacement.

Inventory and availability reads wait up to 250 ms for unrelated hosts and reuse
cached inventories while a host is still responding. Boot waits for fresh discovery
on its selected host; a stalled remote inventory does not hold up local boots.
Only successful, complete discovery can release a missing or stopped device's boot
reservation. Failed or unfinished discovery retains the reservation, and late results
from an invalidated host generation cannot authorize a boot or ownership release.
Crash recovery adopts unresolved records into the boot budget and retries discovery
and shutdown once per second after an attempt completes. It removes evidence only
after confirmed absence, confirmed shutdown state, or successful shutdown; failed
quit-time shutdowns also leave records for the next process.

One SSH worker owns a Mac at a time. An exclusive loopback bind on port 49177 acts as
an OS-released ownership lock; connections to it are immediately closed and it serves
no API. A competing worker, or another application occupying that port, causes startup
to fail. After a worker crash, the next worker can acquire the lock and reclaim recorded
orphaned boots. Normal Simulator.app devices that Ryco did not boot are left running.

Disconnect invalidates pending operations, cached frames, geometry and affected thread
attachments. Other hosts remain usable. Requests already executing may have taken
effect: Ryco never replays a mutation. Refresh discovery after SSH access recovers and
select the device again. Reconnection establishes a fresh worker/handshake. Late replies,
late stream frames and discovery from an invalidated host generation cannot restore
old state. Host status appears below the picker when a configured SSH host needs attention.

## Upstream references and verification

This is an independent implementation using Ryco's existing SSH utilities and device
policy; no upstream source was copied. The upstream license inspected was MIT,
copyright 2026 T3 Tools Inc.

- [t3code v0.0.37](https://github.com/pingdotgg/t3code/releases/tag/v0.0.37), published
  August 31, 2026, is the requested release baseline.
- [PR #10856](https://github.com/pingdotgg/t3code/pull/10856) merged September 10 into
  `t3code/devices-agent-hosts`. Its implementation and reported validation were inspected;
  those reported live results are not Ryco validation.
- Recent release tags checked include
  [v0.0.41-nightly.20260911.1564](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260911.1564)
  and [v0.0.41-nightly.20260912.1576](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260912.1576).
  `apps/server/src/device/SshDeviceHost.ts` was also fetched at the latter tag to verify
  its presence rather than infer inclusion from the feature-branch merge.

Ryco tests exercise routing collisions, single startup, malformed/mismatched protocols,
SSH argument quoting, disconnect rejection, stale discovery and results, independent
streams, and boot cleanup with fake devices and in-memory stdio. They do not establish
real Linux-to-Mac SSH, Xcode session access, simulator streaming, or gesture fidelity.
Android adapters and simulator testing controls remain separate work.

Integration points shared with other device work are `DeviceBackend`, `DeviceManager`,
the device schemas, `DeviceService` construction, the Simulator picker, CLI entrypoint
and server dependency/lockfile. Platform adapters must support independent device
bindings through their backend factory, keep native IDs behind the host router, and
preserve disconnect invalidation and the authoritative boot manager.
