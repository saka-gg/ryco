import { HubWordmark } from "./HubWordmark";

/**
 * The left half of the signed-out gateway on wide screens: the Hub's brand,
 * one line about what it is for, and an illustration of the thing it gives
 * access to.
 *
 * The node rows are an illustration, not data. Nothing about the visitor's
 * machines is known before sign-in, so the rows use generic names a reader
 * cannot mistake for their own, and the whole illustration is hidden from
 * assistive technology rather than announced as a list of machines.
 *
 * The panel keeps the same deep tone in both colour schemes: it is a brand
 * surface, not a content surface, and a full-height light half-screen would
 * glare in dark mode.
 */
export function HubBrandPanel() {
  return (
    <aside className="hub-brand-panel relative hidden h-dvh w-[46%] max-w-[44rem] shrink-0 flex-col overflow-hidden px-12 py-10 text-white lg:sticky lg:top-0 lg:flex xl:px-16 phone:hidden">
      <HubWordmark size="lg" className="text-white [&_svg]:text-white" />

      <div className="relative mt-auto max-w-md">
        <p className="text-balance font-semibold text-[2rem] leading-[1.15] tracking-tight xl:text-[2.25rem]">
          Your coding agents, on every machine you work on.
        </p>
        <p className="mt-4 text-sm text-white/60 leading-relaxed">
          Sign in once to reach the machines shared with your account, from any browser.
        </p>

        <div aria-hidden className="mt-10 space-y-2">
          <IllustrativeNode label="Workstation" detail="2 agents running" online />
          <IllustrativeNode label="Build server" detail="Idle" online />
          <IllustrativeNode label="Laptop" detail="Offline" online={false} />
        </div>
      </div>
    </aside>
  );
}

function IllustrativeNode({
  label,
  detail,
  online,
}: {
  readonly label: string;
  readonly detail: string;
  readonly online: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm backdrop-blur-sm">
      <span
        className={
          online
            ? "size-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgb(52_211_153/0.18)]"
            : "size-2 shrink-0 rounded-full bg-white/30"
        }
      />
      <span className="font-medium font-mono text-[13px] text-white/90">{label}</span>
      <span className="ml-auto text-white/45 text-xs">{detail}</span>
    </div>
  );
}
