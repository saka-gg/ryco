import type { ThreadLocalServer } from "@ryco/contracts";
import { ExternalLinkIcon, LoaderCircleIcon, PanelRightOpenIcon, SquareIcon } from "lucide-react";

import { formatCount } from "~/lib/formatCount";

import type { CrownServersBinding } from "../crownTypes";
import { CrownDetailEmpty, CrownDetailFootnote, CrownDetailHeading } from "./crownDetailPrimitives";

const ORIGIN_LABEL: Readonly<Record<ThreadLocalServer["origin"], string | null>> = {
  agent: "Agent",
  terminal: "Terminal",
  unknown: null,
};

/** A server's name: its page title, else its process name, else its port. */
export function serverDisplayName(server: ThreadLocalServer): string {
  return server.pageTitle ?? server.processName ?? `Port ${server.port}`;
}

function ServerRow({
  server,
  binding,
  actions,
}: {
  server: ThreadLocalServer;
  binding: CrownServersBinding;
  actions: boolean;
}) {
  const name = serverDisplayName(server);
  const origin = ORIGIN_LABEL[server.origin];
  const stopping = binding.stopping.has(server.pid);
  const OpenIcon = binding.opensIn === "browser-panel" ? PanelRightOpenIcon : ExternalLinkIcon;
  return (
    <li
      className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1"
      data-slot="crown-server-row"
      data-port={server.port}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-success"
        data-slot="crown-server-dot"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={name}>
          {name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono tabular-nums">localhost:{server.port}</span>
          {origin ? <span className="truncate">· {origin}</span> : null}
          {server.pageTitle && server.processName ? (
            <span className="truncate">· {server.processName}</span>
          ) : null}
        </span>
      </span>
      {actions ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="crown-icon-btn"
            aria-label={
              binding.opensIn === "browser-panel"
                ? `Open ${name} in the Browser panel`
                : `Open ${name} in your browser`
            }
            onClick={() => binding.open(server)}
          >
            <OpenIcon aria-hidden="true" />
          </button>
          {binding.stop ? (
            <button
              type="button"
              className="crown-icon-btn"
              aria-label={`Stop ${name}`}
              aria-busy={stopping || undefined}
              disabled={stopping}
              data-testid="crown-server-stop"
              onClick={() => binding.stop?.(server)}
            >
              {stopping ? (
                <LoaderCircleIcon aria-hidden="true" className="crown-refresh-spin" />
              ) : (
                <SquareIcon aria-hidden="true" />
              )}
            </button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The Servers section: the dev servers the thread's agents and terminals started that still
 * listen, with their page titles. The card opens and stops them; the flyout previews the list.
 */
export function CrownServersDetail(props: {
  readonly servers: CrownServersBinding;
  readonly variant: "flyout" | "card";
}) {
  const { servers: binding, variant } = props;
  const { servers } = binding;
  return (
    <div
      className="min-w-0 text-[12px] leading-[1.45]"
      data-slot="crown-section-detail"
      data-section="servers"
      data-variant={variant}
    >
      <CrownDetailHeading
        section="servers"
        variant={variant}
        meta={servers.length > 0 ? formatCount(servers.length, "running", "running") : undefined}
      />
      {servers.length > 0 ? (
        <ul className="flex flex-col" data-slot="crown-server-list">
          {servers.map((server) => (
            <ServerRow
              key={`${server.pid}:${server.port}`}
              server={server}
              binding={binding}
              actions={variant === "card"}
            />
          ))}
        </ul>
      ) : (
        <CrownDetailEmpty>No servers running</CrownDetailEmpty>
      )}
      {variant === "card" && binding.remoteNodeLabel ? (
        <CrownDetailFootnote>
          These run on {binding.remoteNodeLabel}; localhost opens there only if the port is
          forwarded.
        </CrownDetailFootnote>
      ) : variant === "flyout" && servers.length > 0 ? (
        <CrownDetailFootnote>
          {binding.stop ? "Click to open or stop them" : "Click to open them"}
        </CrownDetailFootnote>
      ) : null}
    </div>
  );
}
