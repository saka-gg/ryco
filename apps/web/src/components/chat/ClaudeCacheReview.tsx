import { createRoot } from "react-dom/client";
import type { OrchestrationThreadActivity, ClaudeCacheObservation } from "@ryco/contracts";
import {
  latestClaudeCacheObservation,
  type ClaudeCacheReviewPresentation,
  type ClaudeCacheReviewChoice,
} from "@ryco/client-runtime/state/composer";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";

export function ClaudeCacheEvidence({ observation }: { observation: ClaudeCacheObservation }) {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>Observed main-loop request · {new Date(observation.observedAt).toLocaleString()}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt>Direct input</dt>
        <dd>{observation.directInputTokens.toLocaleString()} tokens</dd>
        <dt>Cache reads</dt>
        <dd>{observation.cacheReadInputTokens.toLocaleString()} tokens</dd>
        <dt>Cache writes</dt>
        <dd>{observation.cacheWriteInputTokens.toLocaleString()} tokens</dd>
      </dl>
      {observation.mainLoopTotals && (
        <p>
          Reported cumulative main-loop totals:{" "}
          {observation.mainLoopTotals.directInputTokens.toLocaleString()} direct input,{" "}
          {observation.mainLoopTotals.cacheReadInputTokens.toLocaleString()} cache reads,{" "}
          {observation.mainLoopTotals.cacheWriteInputTokens.toLocaleString()} cache writes, and{" "}
          {observation.mainLoopTotals.outputTokens.toLocaleString()} output tokens. These totals
          cover a different scope from the request above.
        </p>
      )}
      <p>
        Subagent usage is separate. Cache availability for the next request is unknown. These
        observations do not guarantee a cache hit or billing savings.
      </p>
      <p>
        {observation.observedTtlSeconds
          ? `The observed write reported a ${observation.observedTtlSeconds / 60}-minute lifetime; reads do not establish a new lifetime.`
          : "No cache lifetime was reported for this observation."}
      </p>
    </div>
  );
}

export function ClaudeCacheDetails({
  activities,
}: {
  activities: readonly OrchestrationThreadActivity[];
}) {
  const observation = latestClaudeCacheObservation(activities);

  return (
    <details className="mx-3 my-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Observed Claude cache usage</summary>
      <div className="py-2">
        {observation ? (
          <ClaudeCacheEvidence observation={observation} />
        ) : (
          <p>
            No authoritative cache usage is available for this context. Next-request cache
            availability is unknown.
          </p>
        )}
      </div>
    </details>
  );
}

function mountDialog(render: (close: () => void) => React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      root.unmount();
      container.remove();
    });
  };
  root.render(render(close));
  return close;
}

export const claudeCacheReviewPresentation: ClaudeCacheReviewPresentation = {
  review: (review) =>
    new Promise((resolve) => {
      mountDialog((close) => {
        const choose = (choice: ClaudeCacheReviewChoice) => {
          resolve(choice);
          close();
        };
        return (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) choose("cancel");
            }}
          >
            <DialogPopup bottomStickOnMobile={false}>
              <div className="space-y-4 p-6">
                <DialogTitle>Review large Claude resume</DialogTitle>
                <DialogDescription>
                  {review.reason} The last observed prompt contained{" "}
                  {review.promptTokens.toLocaleString()} tokens.
                </DialogDescription>
                <ClaudeCacheEvidence observation={review.observation} />
                <p className="text-sm text-muted-foreground">
                  Compaction summarizes older context and can itself consume tokens. Your message
                  and attachments will wait until native compaction is confirmed.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => choose("continue")}>Continue with full context</Button>
                  <Button variant="outline" onClick={() => choose("compact")}>
                    Compact then send
                  </Button>
                  <Button variant="ghost" onClick={() => choose("cancel")}>
                    Cancel
                  </Button>
                </div>
              </div>
            </DialogPopup>
          </Dialog>
        );
      });
    }),
  compacting: (cancel) =>
    mountDialog((close) => (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            cancel();
            close();
          }
        }}
      >
        <DialogPopup bottomStickOnMobile={false}>
          <div className="space-y-4 p-6">
            <DialogTitle>Compacting Claude context…</DialogTitle>
            <DialogDescription>
              Your original message and attachments are held. Sending waits for successful native
              compaction and a ready session.
            </DialogDescription>
            <Button
              variant="outline"
              onClick={() => {
                cancel();
                close();
              }}
            >
              Cancel pending send
            </Button>
            <p className="text-xs text-muted-foreground">
              Cancelling keeps your draft. Compaction already requested may still finish.
            </p>
          </div>
        </DialogPopup>
      </Dialog>
    )),
};
