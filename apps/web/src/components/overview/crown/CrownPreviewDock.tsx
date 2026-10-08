import type { ReactNode } from "react";

/**
 * Picture-in-picture slot under the rail for the workspace previews
 * (computer beta, background browser). The previews render nothing while
 * idle; the dock's material then collapses away via `:empty`.
 */
export function CrownPreviewDock(props: { readonly children: ReactNode }) {
  return (
    <div className="crown-preview-dock crown-mat" data-slot="crown-preview-dock">
      {props.children}
    </div>
  );
}
