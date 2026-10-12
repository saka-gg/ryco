import { useState } from "react";

import { avatarUrlForAuthor, hashAuthorToHue } from "./CommentThread.logic";

/**
 * Comment author avatar. Its own module, free of the markdown renderer
 * `CommentThread` carries, because avatars also render in shell surfaces such
 * as the sidebar pull request popover that never show a comment body.
 */

function avatarInitials(author: string): string {
  const trimmed = author.trim();
  if (trimmed.length === 0) return "?";
  return trimmed.charAt(0).toUpperCase();
}

export function CommentAvatar({ author, size = 28 }: { author: string; size?: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  const url = avatarUrlForAuthor(author);
  const hue = hashAuthorToHue(author);
  const initials = avatarInitials(author);

  if (!url || imageFailed) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
        style={{ backgroundColor: `hsl(${hue} 60% 40%)`, width: size, height: size }}
        aria-hidden
      >
        {initials}
      </span>
    );
  }

  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setImageFailed(true)}
      className="inline-flex shrink-0 rounded-full bg-muted/40 object-cover"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}
