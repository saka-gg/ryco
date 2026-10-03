import { useNavigate } from "@tanstack/react-router";

import { buildPullRequestLocation } from "../../../pullRequestsRoute";
import { CreatePullRequestDialog } from "./CreatePullRequestDialog";
import { useCreatePullRequestDialogStore } from "./createPullRequestDialogStore";

/**
 * The palette's "New pull request…" dialog, wherever the user is. A created
 * (or already open) request opens on the pull requests page, in a new
 * history entry.
 */
export function CreatePullRequestDialogHost() {
  const open = useCreatePullRequestDialogStore((state) => state.open);
  const request = useCreatePullRequestDialogStore((state) => state.request);
  const setOpen = useCreatePullRequestDialogStore((state) => state.setOpen);
  const navigate = useNavigate();
  const show = (number: number) => {
    setOpen(false);
    if (!request) return;
    void navigate(
      buildPullRequestLocation({
        environmentId: request.environmentId,
        projectId: request.projectId,
        number,
      }),
    );
  };
  return (
    <CreatePullRequestDialog
      open={open}
      onOpenChange={setOpen}
      target={request}
      onCreated={(created) => show(created.number)}
      onOpenExisting={show}
    />
  );
}
