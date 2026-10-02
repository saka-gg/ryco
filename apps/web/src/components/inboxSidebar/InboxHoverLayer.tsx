import { type ReactNode, useMemo, useState } from "react";

import { Tooltip, type TooltipCreateHandle, TooltipPopup } from "../ui/tooltip";
import { InboxHintContext, type InboxHintHandle } from "./InboxRowHint";
import { InboxRowPreview, type InboxRowPreviewPayload } from "./InboxRowPreview";

export type InboxPreviewHandle = ReturnType<typeof TooltipCreateHandle<InboxRowPreviewPayload>>;

/**
 * The inbox's two hover surfaces: one card for every row (it glides between
 * hovered rows and cross-fades its content) and one hint for every precise
 * target inside a row (glyph, change request, time, machine).
 *
 * Base UI closes a hover-opened tooltip when a nested trigger is hovered, and
 * keeps it shut while one is. That is right before the card opens: a hint says
 * exactly one thing. Once the card is open the pointer crosses hints on its way
 * into it, so hints are disabled and the card stays usable. Only hint elements
 * re-render on that switch; `children` (the list) keeps its identity.
 */
export function InboxHoverLayer(props: {
  readonly previewHandle: InboxPreviewHandle;
  readonly hintHandle: InboxHintHandle;
  readonly children: ReactNode;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const context = useMemo(
    () => ({ handle: props.hintHandle, disabled: previewOpen }),
    [props.hintHandle, previewOpen],
  );
  return (
    <InboxHintContext value={context}>
      {props.children}
      <Tooltip handle={props.previewHandle} onOpenChange={(open) => setPreviewOpen(open)}>
        {({ payload }) => (
          <TooltipPopup align="start" side="right" sideOffset={10}>
            {payload ? <InboxRowPreview payload={payload} /> : null}
          </TooltipPopup>
        )}
      </Tooltip>
      <Tooltip handle={props.hintHandle}>
        {({ payload }) => (
          <TooltipPopup side="top" sideOffset={6}>
            {payload}
          </TooltipPopup>
        )}
      </Tooltip>
    </InboxHintContext>
  );
}
