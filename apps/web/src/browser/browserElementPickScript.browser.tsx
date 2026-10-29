// Runs desktop main's element-describe function (@ryco/shared/browserElementPickScript) in real
// Chromium. Test only: no web runtime module imports that script.
import {
  BROWSER_ELEMENT_DESCRIBE_FUNCTION,
  BROWSER_ELEMENT_PAGE_NODE_FUNCTION,
} from "@ryco/shared/browserElementPickScript";
import { afterEach, describe, expect, it } from "vite-plus/test";

interface Described {
  readonly selector: string;
  readonly tagName: string;
  readonly role: string | null;
  readonly name: string | null;
  readonly text: string | null;
  readonly box: { x: number; y: number; width: number; height: number };
}

// Desktop main sends this string with Runtime.callFunctionOn; build the same function here.
const describeFunction = new Function(`return (${BROWSER_ELEMENT_DESCRIBE_FUNCTION})`)() as (
  this: Node,
) => Described | null;
const describeNode = (node: Node) => describeFunction.call(node);
const pageNodeFunction = new Function(`return (${BROWSER_ELEMENT_PAGE_NODE_FUNCTION})`)() as (
  this: Node,
) => Element | null | undefined;

const fixtures: HTMLElement[] = [];
function mount(html: string): HTMLElement {
  const fixture = document.createElement("div");
  fixture.innerHTML = html;
  document.body.append(fixture);
  fixtures.push(fixture);
  return fixture;
}
/** An element of the mounted fixtures. */
function element(selector: string): Element {
  for (const fixture of fixtures) {
    const found = fixture.querySelector(selector);
    if (found) return found;
  }
  throw new Error(`No fixture element ${selector}.`);
}
/** The element a picker selector points at, piercing " >> " shadow hops. */
function resolveSelector(selector: string, roots: Map<Element, ShadowRoot> = new Map()) {
  let scope: Document | ShadowRoot = document;
  let found: Element | null = null;
  for (const part of selector.split(" >> ")) {
    found = scope.querySelector(part);
    if (!found) return null;
    scope = found.shadowRoot ?? roots.get(found) ?? scope;
  }
  return found;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe("browser element describe function", () => {
  it("describes an element with a unique id", () => {
    mount('<button id="save" type="button">Save changes</button>');
    expect(describeNode(element("#save"))).toMatchObject({
      selector: "#save",
      tagName: "button",
      role: "button",
      name: "Save changes",
      text: "Save changes",
    });
  });

  it("skips an id that looks sensitive, duplicated or unsafe", () => {
    mount(`
      <div id="session-token"><span class="a">One</span></div>
      <p id="dup">A</p><p id="dup">B</p>
      <i id="${"nbsp\u00a0id"}">C</i>
      <b id="alice@example.com">D</b>
    `);
    for (const target of [
      element("#session-token > span"),
      fixtures[0]!.querySelectorAll("#dup")[1]!,
      element("i"),
      element("b"),
    ]) {
      const described = describeNode(target);
      expect(described?.selector).not.toMatch(/session|dup|nbsp|alice/u);
      expect(resolveSelector(described!.selector)).toBe(target);
    }
  });

  it("anchors an :nth-of-type path at the nearest unique id", () => {
    mount('<section id="panel"><ul><li>One</li><li>Two</li></ul><ul><li>Three</li></ul></section>');
    const second = element("#panel > ul > li:nth-of-type(2)");
    expect(describeNode(second)?.selector).toBe("#panel > ul:nth-of-type(1) > li:nth-of-type(2)");
    const third = element("#panel > ul:nth-of-type(2) > li");
    expect(describeNode(third)?.selector).toBe("#panel > ul:nth-of-type(2) > li:nth-of-type(1)");
  });

  it("walks to <html> without an anchor and gives up past 1024 characters", () => {
    mount("<div><div><p>Plain</p></div></div>");
    const plain = element("p");
    const selector = describeNode(plain)!.selector;
    expect(selector.startsWith("html > body:nth-of-type(1) > ")).toBe(true);
    expect(resolveSelector(selector)).toBe(plain);
    const deep = mount(`${"<div>".repeat(120)}<span>Deep</span>${"</div>".repeat(120)}`);
    expect(describeNode(deep.querySelector("span")!)).toBeNull();
    // An anchor close to the target keeps it addressable.
    const anchored = mount(
      `${"<div>".repeat(120)}<div id="near"><span>Deep</span></div>${"</div>".repeat(120)}`,
    );
    expect(describeNode(anchored.querySelector("span")!)?.selector).toBe(
      "#near > span:nth-of-type(1)",
    );
  });

  it("names elements from aria-label, labelledby, labels, values and text", () => {
    mount(`
      <button id="close" aria-label="Close dialog">X</button>
      <span id="caption">Delete project</span><button id="delete" aria-labelledby="caption">🗑</button>
      <label for="labelled">Label text</label><button id="labelled">Inner</button>
      <button id="inner">  Inner
        text </button>
      <input id="submit" type="submit" value="Send">
      <img id="logo" alt="Company logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <a id="docs" href="/docs" title="Read the docs">Docs</a>
    `);
    const name = (selector: string) => describeNode(element(selector))?.name;
    expect(name("#close")).toBe("Close dialog");
    expect(name("#delete")).toBe("Delete project");
    expect(name("#labelled")).toBe("Label text");
    expect(name("#inner")).toBe("Inner text");
    expect(name("#submit")).toBe("Send");
    expect(name("#logo")).toBe("Company logo");
    expect(name("#docs")).toBe("Read the docs");
  });

  it("reports implicit roles, and an explicit role first", () => {
    mount(`
      <a id="link" href="/x">Link</a><a id="anchor">Anchor</a>
      <textarea id="area"></textarea>
      <select id="one"><option>A</option></select><select id="many" multiple><option>A</option></select>
      <input id="check" type="checkbox"><input id="radio" type="radio"><input id="range" type="range">
      <input id="number" type="number"><input id="search" type="search"><input id="text">
      <input id="hidden" type="hidden"><input id="reset" type="reset">
      <nav id="nav">N</nav><main id="main">M</main><form id="form"></form><table id="table"></table>
      <ul id="list"><li id="item">I</li></ul><div id="tab" role="tab">T</div><div id="plain">P</div>
    `);
    const role = (id: string) => describeNode(element(`#${id}`))?.role;
    expect(
      Object.fromEntries(
        [
          "link",
          "anchor",
          "area",
          "one",
          "many",
          "check",
          "radio",
          "range",
          "number",
          "search",
          "text",
          "hidden",
          "reset",
          "nav",
          "main",
          "form",
          "table",
          "list",
          "item",
          "tab",
          "plain",
        ].map((id) => [id, role(id)]),
      ),
    ).toEqual({
      link: "link",
      anchor: null,
      area: "textbox",
      one: "combobox",
      many: "listbox",
      check: "checkbox",
      radio: "radio",
      range: "slider",
      number: "spinbutton",
      search: "searchbox",
      text: "textbox",
      hidden: null,
      reset: "button",
      nav: "navigation",
      main: "main",
      form: "form",
      table: "table",
      list: "list",
      item: "listitem",
      tab: "tab",
      plain: null,
    });
  });

  it("never returns a form value or the text of an editable region", () => {
    mount(`
      <input id="secret" value="secret-value" aria-label="Name">
      <input id="password" type="password" value="hunter2">
      <textarea id="notes">private notes</textarea>
      <select id="pick"><option selected>chosen-option</option></select>
      <div id="editor" contenteditable="true"><p id="inside">Draft text</p></div>
      <form id="login"><input type="password" value="pw"><button id="signin">Sign in</button></form>
      <div id="card"><input autocomplete="cc-number" value="4111111111111111"></div>
    `);
    for (const id of ["secret", "password", "notes", "pick", "editor", "inside", "login", "card"]) {
      const described = describeNode(element(`#${id}`));
      expect(described, id).not.toBeNull();
      expect(described?.name, id).toBeNull();
      expect(described?.text, id).toBeNull();
      expect(JSON.stringify(described)).not.toMatch(
        /secret-value|hunter2|private notes|chosen|Draft|4111/u,
      );
    }
    // A button next to the password field is not itself sensitive.
    expect(describeNode(element("#signin"))?.name).toBe("Sign in");
  });

  it("cuts the text of a large container to 280 characters", () => {
    mount(`<main id="big">${"word ".repeat(2_000)}</main>`);
    const text = describeNode(element("#big"))?.text;
    expect(text?.length).toBeLessThanOrEqual(280);
    expect(text?.length).toBeGreaterThan(270);
    expect(text?.endsWith("word")).toBe(true);
  });

  it("chains open and closed shadow roots with >>", () => {
    const root = mount('<x-card id="card"></x-card><x-panel id="panel"></x-panel>');
    const open = root.querySelector("#card")!.attachShadow({ mode: "open" });
    open.innerHTML = "<div><button>Buy</button></div><div><button>Sell</button></div>";
    const closed = root.querySelector("#panel")!.attachShadow({ mode: "closed" });
    closed.innerHTML = '<section><span id="inner">Hidden</span></section>';
    const sell = open.querySelectorAll("button")[1]!;
    const sellSelector = describeNode(sell)!.selector;
    expect(sellSelector).toBe("#card >> div:nth-of-type(2) > button:nth-of-type(1)");
    expect(resolveSelector(sellSelector)).toBe(sell);
    const inner = closed.querySelector("#inner")!;
    expect(describeNode(inner)).toMatchObject({ selector: "#panel >> #inner", text: "Hidden" });
    expect(
      resolveSelector("#panel >> #inner", new Map([[root.querySelector("#panel")!, closed]])),
    ).toBe(inner);
  });

  it("reports the element's viewport box", () => {
    mount(
      '<div id="boxed" style="position:fixed;left:10px;top:20px;width:100px;height:40px">Box</div>',
    );
    expect(describeNode(element("#boxed"))?.box).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });

  it("describes a text node's element and resists clobbered form properties", () => {
    mount(
      '<p id="para">Hello</p><form id="clobbered"><input name="id"><input name="tagName"></form>',
    );
    expect(describeNode(element("#para").firstChild!)?.selector).toBe("#para");
    expect(describeNode(element("#clobbered"))).toMatchObject({
      selector: "#clobbered",
      tagName: "form",
      role: "form",
    });
  });

  it("resists a document's and a form's named properties", () => {
    // Named <img>/<form> elements shadow document members, in every world; named controls shadow
    // their form's members.
    mount(`
      <img name="documentElement" alt=""><img name="getElementById" alt="">
      <form name="querySelectorAll"></form><img name="nodeType" alt="">
      <span id="caption">Pay now</span>
      <div><p>Plain</p></div>
      <form id="checkout">
        <input name="parentElement"><input name="querySelector"><input name="matches">
        <input name="innerText"><input name="getBoundingClientRect"><input name="nodeType">
        <input name="shadowRoot"><input name="previousElementSibling"><input name="getRootNode">
        <section><button aria-labelledby="caption">Go</button></section>
      </form>
    `);
    expect(document.documentElement).not.toBe(document.querySelector("html"));
    const plain = element("div > p");
    const plainSelector = describeNode(plain)!.selector;
    expect(plainSelector.startsWith("html > body:nth-of-type(1) > ")).toBe(true);
    expect(resolveSelector(plainSelector)).toBe(plain);
    const button = element("#checkout button");
    expect(describeNode(button)).toMatchObject({
      selector: "#checkout > section:nth-of-type(1) > button:nth-of-type(1)",
      tagName: "button",
      name: "Pay now",
    });
    const form = element("#checkout");
    expect(describeNode(form)).toMatchObject({
      selector: "#checkout",
      tagName: "form",
      role: "form",
      name: null,
      text: "Go",
    });
    expect(describeNode(form)?.box.width).toBeGreaterThan(0);
  });

  it("maps a node inside same-origin frames to the outermost frame element in the page", async () => {
    mount('<p id="outside">Page</p><iframe id="widget" title="Widget"></iframe>');
    const outer = element("#widget") as HTMLIFrameElement;
    const loaded = (frame: HTMLIFrameElement, html: string) =>
      new Promise<Document>((resolve) => {
        frame.addEventListener("load", () => resolve(frame.contentDocument!), { once: true });
        frame.srcdoc = html;
      });
    const outerDocument = await loaded(
      outer,
      '<button id="pay">Pay</button><iframe id="inner"></iframe>',
    );
    const innerDocument = await loaded(
      outerDocument.getElementById("inner") as HTMLIFrameElement,
      '<a id="deep" href="#">Deep</a>',
    );
    expect(pageNodeFunction.call(element("#outside"))).toBeUndefined();
    expect(pageNodeFunction.call(document)).toBeUndefined();
    expect(pageNodeFunction.call(outerDocument.getElementById("pay")!)).toBe(outer);
    expect(pageNodeFunction.call(innerDocument.getElementById("deep")!.firstChild!)).toBe(outer);
    expect(pageNodeFunction.call(innerDocument)).toBe(outer);
    // The frame element is what gets described.
    expect(describeNode(outer)).toMatchObject({ selector: "#widget", tagName: "iframe" });
  });

  it("returns null for a node outside any document", () => {
    const detached = document.createElement("div");
    detached.innerHTML = "<span>Detached</span>";
    expect(describeNode(detached.firstChild!)).toBeNull();
  });
});
