/**
 * A change request's body and comments under the shared `SOURCE_CONTROL_DETAIL_*` caps. The
 * server's providers cap what they send; the web caps a page's detail before handing it to an
 * agent.
 *
 * @module sourceControlDetailContent
 */
import {
  SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
  SOURCE_CONTROL_DETAIL_COMMENT_BODY_MAX_BYTES,
  SOURCE_CONTROL_DETAIL_MAX_COMMENTS,
} from "@ryco/contracts/source-control";

import { truncateUtf8 } from "./utf8Truncate.ts";

export interface SourceControlDetailContentCommentLike {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface SourceControlDetailContentInput<
  C extends SourceControlDetailContentCommentLike = SourceControlDetailContentCommentLike,
> {
  readonly body: string;
  readonly comments: ReadonlyArray<C>;
}

export interface SourceControlDetailContentOutput<
  C extends SourceControlDetailContentCommentLike = SourceControlDetailContentCommentLike,
> {
  readonly body: string;
  readonly comments: ReadonlyArray<C>;
  readonly truncated: boolean;
}

export function truncateSourceControlDetailContent<C extends SourceControlDetailContentCommentLike>(
  input: SourceControlDetailContentInput<C>,
): SourceControlDetailContentOutput<C> {
  let truncated = false;
  const { value: body, truncated: bodyCut } = truncateUtf8(
    input.body,
    SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
  );
  if (bodyCut) truncated = true;

  let comments = input.comments;
  if (comments.length > SOURCE_CONTROL_DETAIL_MAX_COMMENTS) {
    comments = comments.slice(comments.length - SOURCE_CONTROL_DETAIL_MAX_COMMENTS);
    truncated = true;
  }

  const cappedComments: C[] = [];
  for (const c of comments) {
    const { value, truncated: cBodyCut } = truncateUtf8(
      c.body,
      SOURCE_CONTROL_DETAIL_COMMENT_BODY_MAX_BYTES,
    );
    if (cBodyCut) truncated = true;
    cappedComments.push(c.body === value ? c : ({ ...c, body: value } as C));
  }

  return { body, comments: cappedComments, truncated };
}
