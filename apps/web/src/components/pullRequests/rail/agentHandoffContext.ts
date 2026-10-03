import {
  type SourceControlChangeRequestDetail,
  truncateSourceControlDetailContent,
} from "@ryco/contracts";

/**
 * The page's own detail under the composer's caps: body and comments cut to
 * the shared `SOURCE_CONTROL_DETAIL_*` limits, and none of the files or
 * commits the page reads for its other tabs.
 */
export function capHandoffContextDetail(
  detail: SourceControlChangeRequestDetail,
): SourceControlChangeRequestDetail {
  const { files: _files, commits: _commits, ...rest } = detail;
  const content = truncateSourceControlDetailContent({
    body: detail.body,
    // The shared caps read plain comment fields; each comment rides along.
    comments: detail.comments.map((comment) => ({
      author: comment.author,
      body: comment.body,
      createdAt: "",
      comment,
    })),
  });
  return {
    ...rest,
    body: content.body,
    comments: content.comments.map((entry) => ({ ...entry.comment, body: entry.body })),
    truncated: detail.truncated || content.truncated,
  };
}
