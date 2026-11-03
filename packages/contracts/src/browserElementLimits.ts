// Field limits of a page element the user picked in the Ryco browser. They are Synara's browser
// annotation limits (packages/contracts/src/browserAnnotations.ts at Synara commit
// 299fd573b1d6520c323a87c78d30be74e87e53e1, MIT; see THIRD_PARTY_NOTICES.md).
//
// Apart from the schemas in `projectBrowser.ts` (which re-exports them) so the client runtime's
// startup code can read the limits without taking the browser schemas along.
/** Picked elements one prompt may carry. */
export const BROWSER_ELEMENT_MAX_PER_PROMPT = 32;
export const BROWSER_ELEMENT_MAX_URL_LENGTH = 2_048;
export const BROWSER_ELEMENT_MAX_PAGE_TITLE_LENGTH = 256;
export const BROWSER_ELEMENT_MAX_SELECTOR_LENGTH = 1_024;
export const BROWSER_ELEMENT_MAX_TAG_LENGTH = 64;
export const BROWSER_ELEMENT_MAX_ROLE_LENGTH = 64;
export const BROWSER_ELEMENT_MAX_NAME_LENGTH = 256;
export const BROWSER_ELEMENT_MAX_TEXT_LENGTH = 280;
/** The user's note on a picked element. */
export const BROWSER_ELEMENT_MAX_COMMENT_LENGTH = 4_000;
