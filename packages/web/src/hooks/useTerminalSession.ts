import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import { connectTerminal, type TerminalConnection, type TerminalStatus } from "../lib/terminal/connection";
import { barKeyBytes, NO_MODIFIERS, withModifiers, type BarKey, type Modifiers } from "../lib/terminal/keys";
import { loadTerminalFont, terminalOptions } from "../lib/terminal/theme";
import { isTouch } from "./useIsMobile";

export interface Size {
  cols: number;
  rows: number;
}

interface Live {
  term: Terminal;
  fit: FitAddon;
  connection: TerminalConnection;
  /** What fits this pane. The shell may run at another screen's size until this one claims it. */
  fitted: Size | null;
}

const sameSize = (a: Size | null, b: Size | null) => !!a && !!b && a.cols === b.cols && a.rows === b.rows;

/** The whole buffer as plain text, wrapped lines joined back, for the phone's text selection. */
function bufferText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

/**
 * One terminal on screen: xterm.js in `container`, joined to the shell on the host.
 * Like useChat's stream, this is the one imperative island; what it returns is plain state and actions.
 * The latest screen to resize, focus or type sets the shell's size; another screen shows the shell at that size.
 */
export function useTerminalSession(terminalId: string | null, fontSize: number) {
  const container = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  // xterm's input handler reads the latched modifiers between renders.
  const latched = useRef<Modifiers>(NO_MODIFIERS);
  const initialFontSize = useRef(fontSize);
  const [modifiers, setModifiers] = useState<Modifiers>(NO_MODIFIERS);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [title, setTitle] = useState("");
  const [size, setSize] = useState<Size | null>(null);
  const [fitted, setFitted] = useState<Size | null>(null);
  const [exit, setExit] = useState<{ code: number | null; signal: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latch = useCallback((next: Modifiers) => {
    latched.current = next;
    setModifiers(next);
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!terminalId || !element) return;
    let cleanup = () => {};
    let disposed = false;

    void loadTerminalFont(initialFontSize.current).then(() => {
      if (disposed) return;
      const term = new Terminal(terminalOptions(initialFontSize.current));
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
      // OSC 52: a program on the host (vim, tmux) copies to this device's clipboard.
      term.loadAddon(new ClipboardAddon());
      term.open(element);
      // Phones keep the DOM renderer: iOS takes WebGL contexts away from an app in the background.
      if (!isTouch) {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          term.loadAddon(webgl);
        } catch {
          // No WebGL2: xterm keeps its DOM renderer.
        }
      }

      const claim = (dims: Size) => {
        if (term.cols !== dims.cols || term.rows !== dims.rows) term.resize(dims.cols, dims.rows);
        current.connection.resize(dims.cols, dims.rows);
      };
      const refit = () => {
        const dims = fit.proposeDimensions();
        if (!dims || !Number.isFinite(dims.cols) || dims.cols < 2 || dims.rows < 1) return;
        current.fitted = { cols: dims.cols, rows: dims.rows };
        setFitted(current.fitted);
        claim(current.fitted);
      };
      // Fits before connecting, so the shell starts at this pane's size.
      fit.fit();

      const connection = connectTerminal(terminalId, () => live.current?.fitted ?? { cols: term.cols, rows: term.rows }, {
        status: setStatus,
        attached: (info) => {
          term.reset();
          term.resize(info.cols, info.rows);
          setSize({ cols: info.cols, rows: info.rows });
          setTitle(info.title);
          setExit(null);
          setError(null);
        },
        output: (bytes, drawn) => term.write(bytes, drawn),
        size: (cols, rows) => {
          if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
          setSize({ cols, rows });
        },
        title: setTitle,
        exit: (code, signal) => setExit({ code, signal }),
        error: setError,
      });
      const current: Live = { term, fit, connection, fitted: null };
      live.current = current;
      refit();

      const claimIfElsewhere = () => current.fitted && !sameSize(current.fitted, { cols: term.cols, rows: term.rows }) && claim(current.fitted);
      const onData = term.onData((data) => {
        claimIfElsewhere();
        const mods = latched.current;
        if (mods.ctrl || mods.alt) latch(NO_MODIFIERS);
        connection.input(mods.ctrl || mods.alt ? withModifiers(data, mods) : data);
      });
      // X10 mouse reports carry raw bytes above 127, which must not go through UTF-8.
      const onBinary = term.onBinary((data) => connection.input(Uint8Array.from(data, (c) => c.charCodeAt(0))));
      term.textarea?.addEventListener("focus", claimIfElsewhere);

      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(refit);
      });
      observer.observe(element);

      cleanup = () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        onData.dispose();
        onBinary.dispose();
        connection.close();
        term.dispose();
        live.current = null;
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [terminalId, latch]);

  // External sync: xterm measures cells in pixels, so a new font size needs a refit.
  useEffect(() => {
    const current = live.current;
    if (!current || current.term.options.fontSize === fontSize) return;
    current.term.options.fontSize = fontSize;
    current.fit.fit();
    const dims = { cols: current.term.cols, rows: current.term.rows };
    current.fitted = dims;
    setFitted(dims);
    current.connection.resize(dims.cols, dims.rows);
  }, [fontSize]);

  const pressKey = useCallback(
    (key: BarKey) => {
      const current = live.current;
      if (!current) return;
      if ("modifier" in key) return latch({ ...latched.current, [key.modifier]: !latched.current[key.modifier] });
      const bytes = barKeyBytes(key, latched.current, current.term.modes.applicationCursorKeysMode);
      latch(NO_MODIFIERS);
      if (bytes) current.connection.input(bytes);
    },
    [latch],
  );

  return {
    container,
    status,
    title,
    size,
    /** Another screen set the shell's size, so this one shows it at that size. */
    sizedElsewhere: !!size && !!fitted && !sameSize(size, fitted),
    exit,
    error,
    modifiers,
    pressKey,
    paste: useCallback((text: string) => live.current?.term.paste(text), []),
    fitHere: useCallback(() => {
      const current = live.current;
      if (!current?.fitted) return;
      current.term.resize(current.fitted.cols, current.fitted.rows);
      current.connection.resize(current.fitted.cols, current.fitted.rows);
    }, []),
    readText: useCallback(() => (live.current ? bufferText(live.current.term) : ""), []),
    focus: useCallback(() => live.current?.term.focus(), []),
  };
}

export type TerminalSession = ReturnType<typeof useTerminalSession>;
