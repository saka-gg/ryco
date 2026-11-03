/**
 * The function desktop main runs, with `Runtime.callFunctionOn` in the Ryco browser's
 * `ryco-element-picker` isolated world, on the element the user picked (`this`). Page scripts cannot
 * see, call or patch it: an isolated world has its own globals and prototypes. It returns
 * `{ selector, tagName, role, name, text, box }` with every string collapsed and cut to its contract
 * limit, or `null` when the element cannot be addressed. It never returns a form value (only a
 * button-type input's label) or the text of an editable region. Desktop main normalizes the result
 * again with `normalizeBrowserElementPick`, together with the browser's own URL and title.
 *
 * It lives in `@ryco/shared` only so a web browser test can run it in real Chromium. No web
 * runtime module may import it.
 *
 * The selector, role, accessible-name and sensitive-element heuristics are adapted from Synara
 * (https://github.com/Emanuele-web04/synara, MIT; see THIRD_PARTY_NOTICES.md), commit
 * 299fd573b1d6520c323a87c78d30be74e87e53e1, `apps/desktop/src/browserAnnotations/guestPreload.ts`
 * (`normalizedText`, `cssEscape`, `looksSensitiveLocator`, `uniqueIdSelector`, `uniqueSelector`,
 * `implicitRole`, `labelledByText`, `associatedLabelText`, `elementAccessibleName`,
 * `isSensitiveElement`, `describeElement`). Ryco adds text nodes, shadow-root selectors chained with
 * `" >> "`, the element's box, and fields inside editable shadow hosts.
 *
 * @module browserElementPickScript
 */
import {
  BROWSER_ELEMENT_MAX_NAME_LENGTH,
  BROWSER_ELEMENT_MAX_ROLE_LENGTH,
  BROWSER_ELEMENT_MAX_SELECTOR_LENGTH,
  BROWSER_ELEMENT_MAX_TAG_LENGTH,
  BROWSER_ELEMENT_MAX_TEXT_LENGTH,
} from "@ryco/contracts/project-browser";

// A `function () { … }` declaration for Runtime.callFunctionOn. String.raw keeps the regular
// expressions' backslashes; the code itself must not contain backticks or "${".
export const BROWSER_ELEMENT_DESCRIBE_FUNCTION: string = String.raw`function () {
  "use strict";
  const MAX_SELECTOR = ${BROWSER_ELEMENT_MAX_SELECTOR_LENGTH};
  const MAX_TAG = ${BROWSER_ELEMENT_MAX_TAG_LENGTH};
  const MAX_ROLE = ${BROWSER_ELEMENT_MAX_ROLE_LENGTH};
  const MAX_NAME = ${BROWSER_ELEMENT_MAX_NAME_LENGTH};
  const MAX_TEXT = ${BROWSER_ELEMENT_MAX_TEXT_LENGTH};
  const WORD_CUT_LOOKBACK = 64;
  // Ids with characters the trusted normalizer would rewrite are not used as anchors (CSS.escape
  // keeps a letter after "<", so "<a" stays a tag's start in the selector).
  const UNSAFE_ID = /[\p{Cc}\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]|(?! )\s|<[A-Za-z]/u;
  // Every DOM read goes through the isolated world's own prototypes. Named properties win over
  // built-ins in every world: a document's named elements (<img name="documentElement">,
  // <form name="querySelectorAll">) and a form's named controls (<input name="id">,
  // <input name="parentElement">) would otherwise replace what the script reads.
  const getterOf = (proto, name) => {
    const get = Object.getOwnPropertyDescriptor(proto, name).get;
    return (target) => get.call(target);
  };
  const methodOf = (proto, name) => {
    const method = proto[name];
    return (target, ...args) => method.apply(target, args);
  };
  const tagOf = getterOf(Element.prototype, "tagName");
  const attribute = methodOf(Element.prototype, "getAttribute");
  const hasAttribute = methodOf(Element.prototype, "hasAttribute");
  const matches = methodOf(Element.prototype, "matches");
  const elementQuery = methodOf(Element.prototype, "querySelector");
  const boxOf = methodOf(Element.prototype, "getBoundingClientRect");
  const shadowRootOf = getterOf(Element.prototype, "shadowRoot");
  const previousSiblingOf = getterOf(Element.prototype, "previousElementSibling");
  const nodeTypeOf = getterOf(Node.prototype, "nodeType");
  const parentNodeOf = getterOf(Node.prototype, "parentNode");
  const parentElementOf = getterOf(Node.prototype, "parentElement");
  const textContentOf = getterOf(Node.prototype, "textContent");
  const rootOf = methodOf(Node.prototype, "getRootNode");
  const innerTextOf = getterOf(HTMLElement.prototype, "innerText");
  const isContentEditable = getterOf(HTMLElement.prototype, "isContentEditable");
  const hostOf = getterOf(ShadowRoot.prototype, "host");
  const documentElementOf = getterOf(Document.prototype, "documentElement");
  const documentQueryAll = methodOf(Document.prototype, "querySelectorAll");
  const documentById = methodOf(Document.prototype, "getElementById");
  const fragmentQuery = methodOf(DocumentFragment.prototype, "querySelector");
  const fragmentQueryAll = methodOf(DocumentFragment.prototype, "querySelectorAll");
  const fragmentById = methodOf(DocumentFragment.prototype, "getElementById");

  const normalizedText = (value, max) => {
    const text = String(value == null ? "" : value)
      .slice(0, max * 64)
      .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (text.length <= max) return text;
    const code = text.charCodeAt(max - 1);
    let end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
    if (text[end] !== " ") {
      const space = text.lastIndexOf(" ", end - 1);
      if (space > 0 && end - space <= WORD_CUT_LOOKBACK) end = space;
    }
    return text.slice(0, end).trimEnd();
  };

  const looksSensitiveLocator = (value) =>
    /\b(?:authorization|password|passwd|secret|api[-_]?key|auth|session|token|credential)\b/i.test(value) ||
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) ||
    /(?:^|[-_:])[A-Za-z0-9_-]{24,}(?:$|[-_:])/.test(value);

  const isDocument = (root) => nodeTypeOf(root) === Node.DOCUMENT_NODE;
  const isShadowRoot = (root) => root instanceof ShadowRoot;
  /** querySelectorAll and getElementById of a document or a shadow root. */
  const queryAll = (root, selector) =>
    isDocument(root) ? documentQueryAll(root, selector) : fragmentQueryAll(root, selector);
  const byIdIn = (root, id) => (isDocument(root) ? documentById(root, id) : fragmentById(root, id));

  /** The "#id" selector for an element, when that id is safe to publish and unique in its tree. */
  const uniqueIdSelector = (element, root) => {
    const id = attribute(element, "id");
    if (!id || UNSAFE_ID.test(id) || looksSensitiveLocator(id)) return null;
    const byId = "#" + CSS.escape(id);
    if (byId.length > MAX_SELECTOR) return null;
    try {
      return queryAll(root, byId).length === 1 ? byId : null;
    } catch {
      return null;
    }
  };

  /** A selector inside the element's own tree: its id, or an :nth-of-type path anchored at the nearest unique id. */
  const treeSelector = (element, root) => {
    const byId = uniqueIdSelector(element, root);
    if (byId) return byId;
    const top = isDocument(root) ? documentElementOf(root) : null;
    const segments = [];
    let current = element;
    while (current && current !== top) {
      const parent = parentElementOf(current);
      const tag = tagOf(current).toLowerCase();
      // The top of a shadow tree has no parent element; its siblings are the shadow root's children.
      if (!parent && parentNodeOf(current) !== root) {
        segments.unshift(tag);
        break;
      }
      let index = 1;
      for (let sibling = previousSiblingOf(current); sibling; sibling = previousSiblingOf(sibling))
        if (tagOf(sibling) === tagOf(current)) index += 1;
      segments.unshift(tag + ":nth-of-type(" + index + ")");
      if (!parent) break;
      // Anchoring at the nearest uniquely identified ancestor keeps deep targets inside the limit.
      const anchor = uniqueIdSelector(parent, root);
      if (anchor) {
        const anchored = [anchor, ...segments].join(" > ");
        if (anchored.length <= MAX_SELECTOR) return anchored;
      }
      current = parent;
    }
    if (top) segments.unshift("html");
    const selector = segments.join(" > ");
    return selector.length <= MAX_SELECTOR ? selector : null;
  };

  /** The element's selector; inside a shadow root, its host's selector, " >> ", then the inner one. */
  const selectorFor = (element) => {
    const root = rootOf(element);
    if (!isDocument(root) && !isShadowRoot(root)) return null;
    const inner = treeSelector(element, root);
    if (!inner || isDocument(root)) return inner;
    const outer = selectorFor(hostOf(root));
    if (!outer) return null;
    const chained = outer + " >> " + inner;
    return chained.length <= MAX_SELECTOR ? chained : null;
  };

  const implicitRole = (element) => {
    const tagName = tagOf(element);
    if (tagName === "BUTTON") return "button";
    if (tagName === "A" && hasAttribute(element, "href")) return "link";
    if (tagName === "TEXTAREA") return "textbox";
    if (tagName === "SELECT")
      return element instanceof HTMLSelectElement && (element.multiple || element.size > 1)
        ? "listbox"
        : "combobox";
    if (tagName === "INPUT" && element instanceof HTMLInputElement) {
      const type = String(element.type).toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type !== "hidden") return "textbox";
    }
    if (tagName === "IMG") return "img";
    if (tagName === "MAIN") return "main";
    if (tagName === "NAV") return "navigation";
    if (tagName === "FORM") return "form";
    if (tagName === "TABLE") return "table";
    if (tagName === "LI") return "listitem";
    if (tagName === "UL" || tagName === "OL") return "list";
    return "";
  };

  const labelledByText = (element, root) => {
    const ids = (attribute(element, "aria-labelledby") || "").split(/\s+/).filter(Boolean);
    return ids
      .map((id) => {
        const label = byIdIn(root, id);
        return label ? textContentOf(label) || "" : "";
      })
      .join(" ");
  };

  const associatedLabelText = (element) => {
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLButtonElement
      )
    )
      return "";
    return Array.from(element.labels || [])
      .map((label) => innerTextOf(label))
      .join(" ");
  };

  const elementAccessibleName = (element, root) => {
    const directName =
      attribute(element, "aria-label") ||
      labelledByText(element, root) ||
      associatedLabelText(element) ||
      attribute(element, "alt") ||
      attribute(element, "title") ||
      "";
    if (directName) return normalizedText(directName, MAX_NAME);
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(String(element.type).toLowerCase())
    )
      return normalizedText(element.value, MAX_NAME);
    if (element instanceof HTMLElement && ["BUTTON", "A", "SUMMARY", "OPTION"].includes(tagOf(element)))
      return normalizedText(innerTextOf(element), MAX_NAME);
    return "";
  };

  /** A form field whose text is its value, or an editable region. */
  const isFieldOrEditable = (element) => {
    const tag = tagOf(element);
    return (
      (element instanceof HTMLInputElement &&
        !["button", "submit", "reset", "image"].includes(String(element.type).toLowerCase())) ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      tag === "OPTION" ||
      (element instanceof HTMLElement && isContentEditable(element))
    );
  };

  const SENSITIVE_CONTENT = "input[type='password'], [autocomplete*='cc-' i], [contenteditable]";
  const isSensitiveElement = (element) => {
    if (isFieldOrEditable(element)) return true;
    if (matches(element, "[autocomplete*='password' i], [autocomplete*='cc-' i]")) return true;
    if (elementQuery(element, SENSITIVE_CONTENT) !== null) return true;
    const shadow = shadowRootOf(element);
    if (shadow && fragmentQuery(shadow, SENSITIVE_CONTENT) !== null) return true;
    // Inside a field's or an editable region's shadow tree (an input's inner editor, for one).
    for (let root = rootOf(element); isShadowRoot(root); root = rootOf(hostOf(root)))
      if (isFieldOrEditable(hostOf(root))) return true;
    return false;
  };

  let element = this;
  if (!(element instanceof Node)) return null;
  if (nodeTypeOf(element) === Node.TEXT_NODE) element = parentElementOf(element);
  if (!element || nodeTypeOf(element) !== Node.ELEMENT_NODE) return null;
  const selector = selectorFor(element);
  if (!selector) return null;
  const root = rootOf(element);
  const sensitive = isSensitiveElement(element);
  const roleAttribute = attribute(element, "role");
  const rawText = element instanceof HTMLElement ? innerTextOf(element) : textContentOf(element);
  const rect = boxOf(element);
  return {
    selector,
    tagName: tagOf(element).toLowerCase().slice(0, MAX_TAG),
    role: normalizedText(roleAttribute !== null ? roleAttribute : implicitRole(element), MAX_ROLE) || null,
    name: sensitive ? null : elementAccessibleName(element, root) || null,
    text: sensitive ? null : normalizedText(rawText, MAX_TEXT) || null,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}`;

/**
 * The function desktop main runs first, in the same isolated world, on the node the user picked
 * (`this`). Chromium's inspect tool also reports nodes inside same-process (same-site) iframes, and
 * DOM.resolveNode wraps them in the page's world, where a description would name a node of another
 * document (its selector would not match the page). It returns `undefined` for a node of the page
 * itself, the outermost `<iframe>`/`<frame>` element in the page for a node inside a frame (what a
 * click in an out-of-process frame picks), or `null` when a frame on the way cannot be reached.
 */
export const BROWSER_ELEMENT_PAGE_NODE_FUNCTION: string = String.raw`function () {
  "use strict";
  // Read through this world's own prototypes, like the describe function.
  const ownerDocumentOf = Object.getOwnPropertyDescriptor(Node.prototype, "ownerDocument").get;
  const defaultViewOf = Object.getOwnPropertyDescriptor(Document.prototype, "defaultView").get;
  let node = this;
  for (let hops = 0; hops <= 32; hops += 1) {
    // A frame's node comes from another realm: compare documents, not prototypes.
    const owner = ownerDocumentOf.call(node);
    const nodeDocument = owner === null ? node : owner; // A document is its own.
    if (nodeDocument === document) return hops === 0 ? undefined : node;
    const view = defaultViewOf.call(nodeDocument);
    const frame = view ? view.frameElement : null;
    if (!frame) return null;
    node = frame;
  }
  return null;
}`;
