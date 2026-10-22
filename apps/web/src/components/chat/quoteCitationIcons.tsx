import type { SVGProps } from "react";

/**
 * Lucide's text-quote, message-square-text and pencil glyphs, drawn here:
 * a lucide icon the quote chips alone use would give the composer's route a
 * shared icon chunk of its own (one more request) for three small paths.
 */
function ChipIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function QuoteChipIcon(props: { readonly className?: string }) {
  return (
    <ChipIcon className={props.className}>
      <path d="M17 5H3" />
      <path d="M21 12H8" />
      <path d="M21 19H8" />
      <path d="M3 12v7" />
    </ChipIcon>
  );
}

export function QuoteCommentIcon(props: { readonly className?: string }) {
  return (
    <ChipIcon className={props.className}>
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
      <path d="M7 11h10" />
      <path d="M7 15h6" />
      <path d="M7 7h8" />
    </ChipIcon>
  );
}

export function QuoteEditIcon(props: { readonly className?: string }) {
  return (
    <ChipIcon className={props.className}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </ChipIcon>
  );
}
