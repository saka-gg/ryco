import {
  DEFAULT_AGENT_TOKEN_MODE,
  type AgentTokenMode,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@ryco/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const ASK_MODE_UNSUPPORTED_DESCRIPTION = "Not supported by this provider.";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  tokenMode?: AgentTokenMode;
  showInteractionModeToggle: boolean;
  askModeSupported: boolean;
  /** Why the selected model cannot run Auto mode; the Auto item is disabled with it. */
  autoModeUnavailableReason?: string | null | undefined;
  /**
   * Renders the mode, access, token, and plan sections. The phone tier passes
   * `false`: those axes move to the session-policy sheet there, and the
   * overflow is left carrying provider traits alone. Defaults to `true`, so
   * the compact desktop menu is unchanged.
   */
  showSessionPolicy?: boolean;
  traitsMenuContent?: ReactNode;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTokenModeChange?: (mode: AgentTokenMode) => void;
}) {
  const tokenMode = props.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE;
  const showSessionPolicy = props.showSessionPolicy ?? true;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn(
              "shrink-0 text-muted-foreground/70 hover:text-foreground/80",
              props.runtimeMode === "full-access"
                ? "text-orange-700 hover:text-orange-800 dark:text-orange-400 dark:hover:text-orange-300"
                : undefined,
            )}
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            {showSessionPolicy ? <MenuDivider /> : null}
          </>
        ) : null}
        {showSessionPolicy ? (
          <>
            {props.showInteractionModeToggle ? (
              <>
                <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
                <MenuRadioGroup
                  value={props.interactionMode}
                  onValueChange={(value) => {
                    if (!value || value === props.interactionMode) return;
                    props.onInteractionModeChange(value as ProviderInteractionMode);
                  }}
                >
                  <MenuRadioItem value="default">Chat</MenuRadioItem>
                  <MenuRadioItem value="plan">Plan</MenuRadioItem>
                  <MenuRadioItem value="ask" disabled={!props.askModeSupported}>
                    {props.askModeSupported ? (
                      "Ask"
                    ) : (
                      <span className="grid gap-0.5">
                        <span>Ask</span>
                        <span className="text-muted-foreground text-xs leading-4">
                          {ASK_MODE_UNSUPPORTED_DESCRIPTION}
                        </span>
                      </span>
                    )}
                  </MenuRadioItem>
                </MenuRadioGroup>
                <MenuDivider />
              </>
            ) : null}
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
            <MenuRadioGroup
              value={props.runtimeMode}
              onValueChange={(value) => {
                if (!value || value === props.runtimeMode) return;
                props.onRuntimeModeChange(value as RuntimeMode);
              }}
            >
              <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
              <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
              <MenuRadioItem value="auto" disabled={Boolean(props.autoModeUnavailableReason)}>
                {props.autoModeUnavailableReason ? (
                  <span className="grid gap-0.5">
                    <span>Auto</span>
                    <span className="text-muted-foreground text-xs leading-4">
                      {props.autoModeUnavailableReason}
                    </span>
                  </span>
                ) : (
                  "Auto"
                )}
              </MenuRadioItem>
              <MenuRadioItem value="full-access">Full access</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Tokens</div>
            <MenuRadioGroup
              value={tokenMode}
              onValueChange={(value) => {
                if (!value || value === tokenMode) return;
                props.onTokenModeChange?.(value as AgentTokenMode);
              }}
            >
              <MenuRadioItem value="off">Off</MenuRadioItem>
              <MenuRadioItem value="balanced">Balanced</MenuRadioItem>
              <MenuRadioItem value="aggressive">Aggressive</MenuRadioItem>
            </MenuRadioGroup>
            {props.activePlan ? (
              <>
                <MenuDivider />
                <MenuItem onClick={props.onTogglePlanSidebar}>
                  <ListTodoIcon className="size-4 shrink-0" />
                  {props.planSidebarOpen
                    ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                    : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
                </MenuItem>
              </>
            ) : null}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
