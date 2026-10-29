import {
  WS_METHODS,
  type ChangeRequestTemplate,
  type EnvironmentId,
  type ServerConfig,
} from "@ryco/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { readEnvironmentApi } from "../../../environmentApi";
import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import { useEnvironmentServerConfigSelector } from "../../../hooks/useChatsAvailability";
import { useWsConnectionOpenedCount } from "../../../rpc/wsConnectionState";
import { initialTemplate, isDescriptionPristine } from "./createPullRequest.logic";

export type ChangeRequestTemplatesStatus = "idle" | "loading" | "ready" | "failed";

const NO_TEMPLATES: ReadonlyArray<ChangeRequestTemplate> = [];

// Module level, so unrelated config pushes (provider probes) never re-render.
const selectTemplatesEnabled = (config: ServerConfig | null): boolean =>
  config?.environment.capabilities.changeRequestTemplates === true &&
  config.settings.pullRequestTemplates;

/**
 * The base branch's change request templates, read by the node from the repository (no
 * fetch). Idle without a base, on nodes too old to read templates, with the
 * "Pull request templates" setting off, and while a hosted session cannot read yet; a stale
 * answer for an earlier base is dropped. A failed read is tried again once a connection
 * opens (a reconnect, or the environment's first connection).
 */
export function useChangeRequestTemplates(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly baseRefName: string | null;
}): {
  readonly status: ChangeRequestTemplatesStatus;
  readonly templates: ReadonlyArray<ChangeRequestTemplate>;
  /** The template a new description starts from, as the server chose it; null for none. */
  readonly generationTemplatePath: string | null;
  /** Identifies the read the templates answer (environment, checkout and base). */
  readonly key: string;
} {
  const { environmentId, cwd, baseRefName } = input;
  const enabled = useEnvironmentServerConfigSelector(environmentId, selectTemplatesEnabled);
  // A hosted session reads only once its lifecycle owner admits the method.
  const allowed = useHostedRpcCapability(
    WS_METHODS.sourceControlListChangeRequestTemplates,
    environmentId,
  ).allowed;
  const [result, setResult] = useState<{
    readonly key: string;
    readonly status: "ready" | "failed";
    readonly templates: ReadonlyArray<ChangeRequestTemplate>;
    readonly generationTemplatePath: string | null;
    /** For a failed read: the socket opens counted when it started. */
    readonly failedAtOpenCount?: number;
  } | null>(null);
  const key = `${environmentId}\0${cwd}\0${baseRefName ?? ""}`;
  const active = enabled && allowed && baseRefName !== null;
  const openCount = useWsConnectionOpenedCount();
  const readOpenCount = useEffectEvent(() => openCount);
  // A read is due without an answer for this key, and again after a failure once a socket opened.
  const due =
    active &&
    (result?.key !== key || (result.status === "failed" && result.failedAtOpenCount !== openCount));

  useEffect(() => {
    if (!due) return;
    let cancelled = false;
    const startedAtOpenCount = readOpenCount();
    const list = readEnvironmentApi(environmentId)?.sourceControl.listChangeRequestTemplates;
    const read = list
      ? list({ cwd, baseRefName: baseRefName ?? undefined })
      : Promise.reject(new Error("Templates are unavailable."));
    read.then(
      (answer) => {
        if (cancelled) return;
        setResult({
          key,
          status: "ready",
          templates: answer.templates,
          generationTemplatePath: answer.generationTemplatePath,
        });
      },
      () => {
        if (cancelled) return;
        setResult({
          key,
          status: "failed",
          templates: NO_TEMPLATES,
          generationTemplatePath: null,
          failedAtOpenCount: startedAtOpenCount,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [baseRefName, cwd, due, environmentId, key]);

  if (!active) {
    return { status: "idle", templates: NO_TEMPLATES, generationTemplatePath: null, key };
  }
  if (result?.key !== key) {
    return { status: "loading", templates: NO_TEMPLATES, generationTemplatePath: null, key };
  }
  return {
    status: result.status,
    templates: result.templates,
    generationTemplatePath: result.generationTemplatePath,
    key,
  };
}

/**
 * The description field of the create dialog with the repository's templates: the template a
 * generated description follows fills an untouched description when the templates arrive or
 * the base changes, and the picker swaps templates until the author edits the text.
 */
export function useTemplatedDescription(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly baseRefName: string | null;
}) {
  const templates = useChangeRequestTemplates(input);
  const [body, setBody] = useState("");
  // The text the last template choice put in; the description is untouched while it is equal.
  const [inserted, setInserted] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [appliedAnswer, setAppliedAnswer] = useState<string | null>(null);

  const apply = (template: ChangeRequestTemplate | null) => {
    setBody(template?.body ?? "");
    setInserted(template?.body ?? null);
    setSelectedPath(template?.path ?? null);
  };

  const pristine = isDescriptionPristine(body, inserted);
  // Adjusted during render (no effect, no flash of the old text) once per answer: per read,
  // and again when a failed read succeeds on retry. A failed read counts as no templates, so an
  // untouched description never keeps an earlier base's template.
  const answer =
    templates.status === "ready" || templates.status === "failed"
      ? `${templates.key}\0${templates.status}`
      : null;
  if (answer !== null && answer !== appliedAnswer) {
    setAppliedAnswer(answer);
    if (pristine) apply(initialTemplate(templates.templates, templates.generationTemplatePath));
  }

  const listed = templates.status === "ready" ? templates.templates : NO_TEMPLATES;
  return {
    body,
    setBody,
    templates: listed,
    /** The template the description holds; none once it was cleared or the base changed. */
    selectedPath:
      body.trim().length > 0 && listed.some((template) => template.path === selectedPath)
        ? selectedPath
        : null,
    /** Switching would replace text the author wrote. */
    locked: !pristine,
    choose: (path: string | null) => {
      if (!pristine) return;
      apply(listed.find((template) => template.path === path) ?? null);
    },
  };
}
