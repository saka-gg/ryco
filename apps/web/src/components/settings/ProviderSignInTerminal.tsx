import "@xterm/xterm/css/xterm.css";

import type {
  ProviderSignInController,
  ProviderSignInOutput,
} from "@ryco/client-runtime/state/providerSignIn";
import { createTerminalReplayGate } from "@ryco/client-runtime/state/terminal";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { readLocalApi } from "../../localApi";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../../terminal-links";
import {
  followAppTerminalAppearance,
  readTerminalFontFamily,
  terminalFollowsWindowGlass,
  terminalThemeFromApp,
} from "../terminal/terminalTheme";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The address a sign-in link opens on this device: `https:` only, anything else stays text. */
export function providerSignInLinkTarget(text: string): string | null {
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function openSignInLink(text: string): void {
  const target = providerSignInLinkTarget(text);
  if (target === null) return;
  void readLocalApi()
    ?.shell.openExternal(target)
    .catch(() => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open the link",
          description: "Copy the address from the terminal and open it in a browser.",
        }),
      );
    });
}

export interface ProviderSignInTerminalProps {
  readonly controller: ProviderSignInController;
  /** Whether the login takes input now; once it exited its output stays readable. */
  readonly interactive: boolean;
}

/**
 * The terminal of a sign-in run on a node: the login's output as the controller receives it, and
 * what the person types, pastes or the terminal answers going back through the controller. It
 * fills its parent and takes that parent's colors. Output it did not see live (what the controller
 * held when it mounted, a node's resent tail) is a replay: the terminal does not answer the
 * queries in it again. Links open on this device, `https:` ones only, on a plain click: the
 * address is what a sign-in is for. Its size goes to the node while the login takes input.
 */
export function ProviderSignInTerminal({ controller, interactive }: ProviderSignInTerminalProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const surface = () => mount.parentElement ?? mount;
    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      lineHeight: 1.2,
      fontSize: 12,
      scrollback: 1_000,
      fontFamily: readTerminalFontFamily(),
      allowTransparency: terminalFollowsWindowGlass(),
      theme: terminalThemeFromApp(surface()),
      // Hyperlinks the login marks up itself (OSC 8); plain addresses come from the provider below.
      linkHandler: { activate: (_event, text) => openSignInLink(text) },
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();
    terminalRef.current = terminal;

    const replayGate = createTerminalReplayGate(terminal);
    const write = ({ reset, replay, data }: ProviderSignInOutput) => {
      // A full reset in band, so output written before it is parsed first.
      const text = reset ? `\u001bc${data}` : data;
      if (text.length === 0) return;
      if (replay) replayGate.replay(() => terminal.write(text));
      else terminal.write(text);
    };
    write({ reset: false, replay: true, data: controller.output() });
    const stopOutput = controller.onOutput(write);

    const inputDisposable = terminal.onData((data) => {
      if (replayGate.dropsData(data)) return;
      controller.sendInput(data);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      controller.resize(cols, rows);
    });
    const linksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        // A long address wraps over several rows; each row links the whole of it.
        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (index) =>
          terminal.buffer.active.getLine(index),
        );
        const links = wrappedLine
          ? extractTerminalLinks(wrappedLine.text).flatMap((match) => {
              if (match.kind !== "url" || providerSignInLinkTarget(match.text) === null) return [];
              const range = resolveWrappedTerminalLinkRange(wrappedLine, match);
              if (!wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber)) return [];
              return [{ text: match.text, range, activate: () => openSignInLink(match.text) }];
            })
          : [];
        callback(links.length === 0 ? undefined : links);
      },
    });

    let fitFrame: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (fitFrame !== null) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        fitAddon.fit();
      });
    });
    resizeObserver.observe(mount);
    const stopFollowingAppearance = followAppTerminalAppearance(terminal, {
      theme: () => terminalThemeFromApp(surface()),
      refit: () => fitAddon.fit(),
    });

    return () => {
      terminalRef.current = null;
      stopOutput();
      stopFollowingAppearance();
      resizeObserver.disconnect();
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      linksDisposable.dispose();
      terminal.dispose();
    };
  }, [controller]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !interactive;
    terminal.options.cursorBlink = interactive;
    if (!interactive) return;
    // The node's terminal takes this size; the controller sends it once the login takes input.
    controller.resize(terminal.cols, terminal.rows);
    // Typing goes here once the login asks, unless the person is busy elsewhere on the page.
    const focused = document.activeElement;
    const region = mountRef.current?.closest("section");
    if (focused === null || focused === document.body || region?.contains(focused)) {
      terminal.focus();
    }
  }, [controller, interactive]);

  return <div ref={mountRef} className="size-full" />;
}
