import { EventEmitter } from "events";
import { accessSync, constants, existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Response } from "playwright-core";
import type { PreviewClientMessage, PreviewColorScheme, PreviewElement, PreviewPage, PreviewServerMessage, PreviewViewport } from "@chomp/shared";

const PRESETS = { tablet: { width: 768, height: 1024 }, mobile: { width: 375, height: 812 } } as const;
const NO_PANE = { width: 1280, height: 800, dpr: 1, dark: false };
const MAX_DPR = 2;
const MAX_FRAME_PX = 3840;
const KEPT_CONSOLE = 500;
const KEPT_REQUESTS = 300;
const IDLE_CLOSE_MS = 30 * 60_000;
/** Each open page is a Chromium renderer of its own, so only this many stay open; a new one closes the oldest unwatched. */
export const MAX_SESSIONS = 4;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const ACTION_SETTLE_MS = 150;
const CLOSED_BECAUSE = {
  crashed: "The page crashed. Chromium on the server most likely ran out of memory: heavy pages, such as 3D, are the usual cause.",
  browserStopped: "Chromium on the server stopped, most likely out of memory.",
  idle: "It closed after 30 minutes unused.",
  full: `It closed to make room for another chat's page: ${MAX_SESSIONS} stay open at most.`,
} as const;
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const CROP_PADDING_PX = 24;

// Runs in the page: the element at a point, described so a person and an agent can both tell which one it is.
// A point on the text inside a button or link means that button or link.
const DESCRIBE_AT = `(x, y) => {
  let el = document.elementFromPoint(x, y);
  if (!el) return null;
  el = el.closest("button, a, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem]") ?? el;
  const roles = { BUTTON: "button", A: "link", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox", IMG: "img", NAV: "navigation", LI: "listitem", P: "paragraph", UL: "list", OL: "list", TABLE: "table", FORM: "form", HEADER: "banner", FOOTER: "contentinfo", MAIN: "main" };
  const tag = el.tagName;
  const inputRoles = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", range: "slider" };
  const role = el.getAttribute("role") || (tag === "INPUT" && (inputRoles[el.type] || "textbox")) || (/^H[1-6]$/.test(tag) && "heading") || roles[tag] || tag.toLowerCase();
  const squash = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
  const name = squash(el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? el.getAttribute("placeholder") ?? el.innerText ?? el.value).slice(0, 60);
  const path = [];
  for (let node = el; node && node.nodeType === 1 && path.length < 6; node = node.parentElement) {
    if (node.id) { path.unshift("#" + CSS.escape(node.id)); break; }
    const step = node.tagName.toLowerCase();
    const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
    path.unshift(same.length > 1 ? step + ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : step);
    if (step === "body") break;
  }
  const r = el.getBoundingClientRect();
  return { label: name ? role + " \\"" + name + "\\"" : role, selector: path.join(" > "), box: { x: r.x, y: r.y, width: r.width, height: r.height }, text: squash(el.innerText ?? el.value).slice(0, 200) };
}`;

export interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  source: string | null;
}

export interface RequestEntry {
  id: number;
  at: number;
  method: string;
  url: string;
  type: string;
  status: number | null;
  failure: string | null;
}

/** A pane watching a chat's preview. The session sends it frames and tells the socket when its state changes. */
export interface Viewer {
  conversationId: string;
  pane: { width: number; height: number; dpr: number; dark: boolean } | null;
  sendFrame(frame: Buffer): void;
  send(message: PreviewServerMessage): void;
}

/** "state" (conversationId) whenever what the pane shows about the page may have changed; "console" (conversationId, entry) per message. */
export const previewEvents = new EventEmitter();
previewEvents.setMaxListeners(0);

function chromeCandidates(): string[] {
  const playwrightCache = join(homedir(), ".cache", "ms-playwright");
  const cached = existsSync(playwrightCache)
    ? readdirSync(playwrightCache)
        .filter((d) => d.startsWith("chromium"))
        .sort()
        .reverse()
        .flatMap((d) => ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"].map((f) => join(playwrightCache, d, f)))
    : [];
  return [
    process.env.CHOMP_PREVIEW_CHROME ?? "",
    chromium.executablePath(),
    ...cached,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
}

interface Chromium {
  browser: Browser;
  /** Its own user agent without "Headless", which some dev servers and sites refuse. */
  userAgent: string;
}

export function chromeExecutable(): string | undefined {
  return chromeCandidates().find((p) => p && existsSync(p));
}

/**
 * The server's GPU, if Chromium may open it: the chomp unit needs the render group. Without it, 3D pages draw on the CPU
 * at a few frames a second on most of the cores. Measured on a Radeon 780M: ANGLE on EGL, as Vulkan failed in full Chrome.
 */
function gpuArgs(): string[] {
  try {
    accessSync("/dev/dri/renderD128", constants.R_OK | constants.W_OK);
  } catch {
    return [];
  }
  return ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"];
}

let chromiumProcess: Promise<Chromium> | null = null;

function launchBrowser(): Promise<Chromium> {
  if (chromiumProcess) return chromiumProcess;
  const executablePath = chromeExecutable();
  if (!executablePath) {
    throw new Error("No Chromium on this host. Install one with `pnpm --filter @chomp/api exec playwright-core install chromium`, or set CHOMP_PREVIEW_CHROME to a Chrome binary.");
  }
  const launching = chromium.launch({ executablePath, headless: true, args: gpuArgs() }).then(async (browser) => {
    browser.once("disconnected", () => {
      if (chromiumProcess === launching) chromiumProcess = null;
      for (const session of sessions.values()) if (session.browser === browser) session.close(CLOSED_BECAUSE.browserStopped);
    });
    const cdp = await browser.newBrowserCDPSession();
    const { userAgent } = await cdp.send("Browser.getVersion");
    await cdp.detach();
    return { browser, userAgent: userAgent.replace("HeadlessChrome", "Chrome") };
  });
  chromiumProcess = launching;
  launching.catch(() => {
    if (chromiumProcess === launching) chromiumProcess = null;
  });
  return launching;
}

function closeBrowserIfUnused() {
  if (sessions.size || opening.size || !chromiumProcess) return;
  const closing = chromiumProcess;
  chromiumProcess = null;
  void closing.then(({ browser }) => browser.close()).catch(() => {});
}

const viewers = new Map<string, Set<Viewer>>();
const sessions = new Map<string, PreviewSession>();
const opening = new Map<string, Promise<PreviewSession>>();
/** Where a closed session was, and why when nobody asked, so the pane can say so and offer it again. Lost on restart, like the page. */
const closedPages = new Map<string, { url: string | null; because: string | null }>();

const viewersOf = (conversationId: string) => viewers.get(conversationId) ?? new Set<Viewer>();

export class PreviewSession {
  private page!: Page;
  /** A promise, so a page that is still attaching is waited for rather than missed. */
  private cdp!: Promise<CDPSession>;
  private casting = false;
  private loading = false;
  lastUsed = Date.now();
  private nextRequestId = 1;
  private readonly requestIds = new WeakMap<object, RequestEntry>();
  private readonly responses = new Map<number, Response>();
  readonly console: ConsoleEntry[] = [];
  readonly requests: RequestEntry[] = [];
  private viewport: { preset: PreviewViewport["preset"]; width: number; height: number; colorScheme: PreviewColorScheme } = {
    preset: "desktop",
    width: NO_PANE.width,
    height: NO_PANE.height,
    colorScheme: "system",
  };

  private constructor(
    readonly conversationId: string,
    private readonly context: BrowserContext,
    private readonly desktopUserAgent: string,
  ) {}

  static async open(conversationId: string): Promise<PreviewSession> {
    const { browser, userAgent } = await launchBrowser();
    // No viewport: the session sets the size itself over CDP, following the pane.
    const context = await browser.newContext({ viewport: null });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const session = new PreviewSession(conversationId, context, userAgent);
    session.listen();
    // The context's "page" event may have attached it already; attach() is a no-op then.
    session.attach(await context.newPage());
    await session.cdp;
    return session;
  }

  get browser(): Browser | null {
    return this.context.browser();
  }

  private listen() {
    this.context.on("console", (msg) => {
      const loc = msg.location();
      this.pushConsole(msg.type(), msg.text(), loc.url ? `${loc.url}:${loc.lineNumber}` : null);
    });
    this.context.on("weberror", (e) => this.pushConsole("error", e.error().stack ?? e.error().message, null));
    this.context.on("dialog", (d) => {
      this.pushConsole("dialog", `${d.type()}: ${d.message()}`, null);
      // Nobody can answer a dialog in the stream, so it is accepted, as a click on OK would.
      void d.accept().catch(() => {});
    });
    this.context.on("request", (r) => {
      if (r.url().startsWith("data:")) return;
      if (r.isNavigationRequest() && r.frame() === this.page?.mainFrame()) this.setLoading(true);
      const entry: RequestEntry = { id: this.nextRequestId++, at: Date.now(), method: r.method(), url: r.url(), type: r.resourceType(), status: null, failure: null };
      this.requestIds.set(r, entry);
      this.requests.push(entry);
      if (this.requests.length > KEPT_REQUESTS) this.responses.delete(this.requests.shift()!.id);
    });
    this.context.on("response", (res) => {
      const entry = this.requestIds.get(res.request());
      if (!entry) return;
      entry.status = res.status();
      this.responses.set(entry.id, res);
    });
    this.context.on("requestfailed", (r) => {
      const entry = this.requestIds.get(r);
      if (entry) entry.failure = r.failure()?.errorText ?? "failed";
    });
    // A link that opens a new tab takes over the stream, as the pane has no tabs.
    this.context.on("page", (p) => void this.attach(p));
  }

  private pushConsole(level: string, text: string, source: string | null) {
    const entry = { at: Date.now(), level, text, source };
    this.console.push(entry);
    if (this.console.length > KEPT_CONSOLE) this.console.shift();
    previewEvents.emit("console", this.conversationId, entry);
  }

  private setLoading(loading: boolean) {
    this.loading = loading;
    this.changed();
  }

  private changed() {
    previewEvents.emit("state", this.conversationId);
  }

  private attach(page: Page) {
    if (this.page === page) return;
    const previous = this.cdp;
    this.page = page;
    this.casting = false;
    this.cdp = this.context.newCDPSession(page).then((cdp) => {
      cdp.on("Page.screencastFrame", (frame) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        this.broadcastFrame(Buffer.from(frame.data, "base64"));
      });
      return cdp;
    });
    void previous?.then((cdp) => cdp.detach()).catch(() => {});
    page.on("framenavigated", (f) => f === page.mainFrame() && this.changed());
    page.on("load", () => this.setLoading(false));
    // Every call on a crashed page throws, so the session goes and the pane offers the page again.
    page.on("crash", () => this.page === page && this.close(CLOSED_BECAUSE.crashed));
    page.on("close", () => {
      if (this.page !== page) return;
      const rest = this.context.pages();
      if (rest.length) this.attach(rest[rest.length - 1]);
      else void this.context.newPage().then((p) => this.attach(p)).catch(() => {});
    });
    void this.applyViewport().then(() => this.syncScreencast());
  }

  /** The header carries the CSS size pointers map onto; Chrome's frame metadata gives device pixels once frames are full size. */
  private broadcastFrame(jpeg: Buffer, to: Iterable<Viewer> = viewersOf(this.conversationId)) {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(this.viewport.width, 0);
    header.writeUInt16BE(this.viewport.height, 2);
    const frame = Buffer.concat([header, jpeg]);
    for (const viewer of to) viewer.sendFrame(frame);
  }

  /** Streams only while someone watches, so an agent working alone pays nothing for it. */
  async syncScreencast() {
    const watched = viewersOf(this.conversationId).size > 0;
    if (watched === this.casting) return;
    this.casting = watched;
    const cdp = await this.cdp;
    // Without a maximum, frames come at CSS size, which is blurry on a retina screen.
    const start = { format: "jpeg", quality: 70, maxWidth: MAX_FRAME_PX, maxHeight: MAX_FRAME_PX } as const;
    await (watched ? cdp.send("Page.startScreencast", start) : cdp.send("Page.stopScreencast")).catch(() => {});
  }

  /** The screencast only sends changes, so a viewer that joins, or a size change on a still page, needs a picture of its own. */
  async sendCurrentFrame(to?: Viewer[]) {
    const shot = await (await this.cdp).send("Page.captureScreenshot", { format: "jpeg", quality: 70 }).catch(() => null);
    if (shot) this.broadcastFrame(Buffer.from(shot.data, "base64"), to);
  }

  /** The newest pane decides the size of a desktop page and what "system" colours mean. */
  private pane() {
    return [...viewersOf(this.conversationId)].reverse().find((v) => v.pane)?.pane ?? NO_PANE;
  }

  async applyViewport() {
    const pane = this.pane();
    const { preset } = this.viewport;
    const fixed = preset === "tablet" || preset === "mobile" ? PRESETS[preset] : null;
    if (preset === "desktop") Object.assign(this.viewport, { width: Math.round(pane.width), height: Math.round(pane.height) });
    if (fixed) Object.assign(this.viewport, fixed);
    const mobile = preset === "mobile";
    const { width, height, colorScheme } = this.viewport;
    const dark = colorScheme === "system" ? pane.dark : colorScheme === "dark";
    const cdp = await this.cdp;
    await Promise.all([
      cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: Math.min(pane.dpr, MAX_DPR), mobile, screenWidth: width, screenHeight: height }),
      // Touch support without turning mouse events into touches: that hangs Playwright's clicks and the page with them.
      cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 }),
      cdp.send("Emulation.setUserAgentOverride", { userAgent: mobile ? MOBILE_UA : this.desktopUserAgent }),
      cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }),
    ]).catch(() => {});
    if (this.casting) await this.sendCurrentFrame();
    this.changed();
  }

  async resize(args: { preset?: "desktop" | "tablet" | "mobile"; width?: number; height?: number; colorScheme?: PreviewColorScheme }) {
    this.touch();
    if (args.width !== undefined || args.height !== undefined) {
      if (!args.width || !args.height) throw new Error("Give both width and height, or a preset.");
      Object.assign(this.viewport, { preset: "custom", width: Math.round(args.width), height: Math.round(args.height) });
    } else if (args.preset) {
      this.viewport.preset = args.preset;
    }
    if (args.colorScheme) this.viewport.colorScheme = args.colorScheme;
    await this.applyViewport();
  }

  touch() {
    this.lastUsed = Date.now();
  }

  get watched(): boolean {
    return viewersOf(this.conversationId).size > 0;
  }

  get idle(): boolean {
    return !this.watched && Date.now() - this.lastUsed > IDLE_CLOSE_MS;
  }

  /** The local port the page is on, so the dev server behind it counts as in use. */
  get localPort(): number | null {
    try {
      const url = new URL(this.page.url());
      return LOCAL_HOSTS.has(url.hostname) ? Number(url.port || 80) : null;
    } catch {
      return null;
    }
  }

  async state(): Promise<PreviewPage> {
    const history = await (await this.cdp).send("Page.getNavigationHistory").catch(() => null);
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      loading: this.loading,
      canGoBack: !!history && history.currentIndex > 0,
      canGoForward: !!history && history.currentIndex < history.entries.length - 1,
      viewport: { ...this.viewport },
    };
  }

  async goto(url: string) {
    this.touch();
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("The preview opens http and https pages only.");
    await this.page.goto(parsed.href, { waitUntil: "domcontentloaded" });
  }

  async history(action: "back" | "forward" | "reload") {
    this.touch();
    const options = { waitUntil: "domcontentloaded" } as const;
    if (action === "reload") await this.page.reload(options);
    else if (action === "back") await this.page.goBack(options);
    else await this.page.goForward(options);
  }

  /** The user's own input from the pane, in the page's CSS pixels. */
  async input(message: Extract<PreviewClientMessage, { type: "mouse" | "wheel" | "press" | "text" }>) {
    this.touch();
    if (message.type === "mouse") {
      const type = ({ down: "mousePressed", up: "mouseReleased", move: "mouseMoved" } as const)[message.event];
      const buttons = message.event === "up" || message.button === "none" ? 0 : ({ left: 1, right: 2, middle: 4 } as const)[message.button];
      await (await this.cdp).send("Input.dispatchMouseEvent", { type, x: message.x, y: message.y, button: message.button, buttons, clickCount: message.clickCount, modifiers: message.modifiers });
    } else if (message.type === "wheel") {
      await (await this.cdp).send("Input.dispatchMouseEvent", { type: "mouseWheel", x: message.x, y: message.y, deltaX: message.dx, deltaY: message.dy });
    } else if (message.type === "press") {
      await this.page.keyboard.press(message.key);
    } else {
      await this.page.keyboard.insertText(message.text);
    }
  }

  /** Tells the pane where the agent acts, so the user sees it happen. */
  private async showAgent(action: string, target: Locator | { x: number; y: number } | null) {
    let point: { x: number; y: number } | null = null;
    if (target && "x" in target) point = target;
    else if (target) {
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (box) point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    for (const viewer of viewersOf(this.conversationId)) viewer.send({ type: "agent", action, x: point?.x ?? null, y: point?.y ?? null });
  }

  /** What is at a point, for the user pointing at it; with crop, a picture of it and a little around it. */
  async inspect(x: number, y: number, crop: boolean): Promise<PreviewElement | null> {
    this.touch();
    const element = (await this.page.evaluate(`(${DESCRIBE_AT})(${x}, ${y})`)) as PreviewElement | null;
    if (!element || !crop) return element;
    const { box } = element;
    const left = Math.max(0, box.x - CROP_PADDING_PX);
    const top = Math.max(0, box.y - CROP_PADDING_PX);
    const clip = {
      x: left,
      y: top,
      width: Math.max(1, Math.min(this.viewport.width, box.x + box.width + CROP_PADDING_PX) - left),
      height: Math.max(1, Math.min(this.viewport.height, box.y + box.height + CROP_PADDING_PX) - top),
    };
    const picture = await this.page.screenshot({ type: "jpeg", quality: 80, scale: "css", clip });
    return { ...element, crop: picture.toString("base64") };
  }

  async snapshot(): Promise<string> {
    this.touch();
    return this.page.ariaSnapshot({ mode: "ai" });
  }

  async screenshot(): Promise<Buffer> {
    this.touch();
    // CSS scale, so the picture's pixels are the coordinates preview_act takes.
    return this.page.screenshot({ type: "jpeg", quality: 75, scale: "css" });
  }

  async act(args: ActArgs): Promise<void> {
    this.touch();
    const { page } = this;
    const ref = (r: string) => page.locator(`aria-ref=${r}`);
    const target = args.ref ? ref(args.ref) : null;
    const point = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : null;
    // An unknown ref would wait out the whole timeout, so it fails at once with what to do instead.
    for (const r of [args.ref, args.to_ref]) {
      if (r && (await ref(r).count()) === 0) throw new Error(`No element has ref ${r} now. Refs belong to the latest preview_snapshot, so take a new one.`);
    }
    const needTarget = () => {
      if (!target && !point) throw new Error(`${args.action} needs a ref from preview_snapshot, or x and y.`);
    };

    switch (args.action) {
      case "click":
      case "double_click":
      case "right_click": {
        needTarget();
        const options = { button: args.action === "right_click" ? "right" : "left", clickCount: args.action === "double_click" ? 2 : 1 } as const;
        await this.showAgent(args.action, target ?? point);
        if (target) await target.click(options);
        else await page.mouse.click(point!.x, point!.y, options);
        break;
      }
      case "hover":
        needTarget();
        await this.showAgent("hover", target ?? point);
        if (target) await target.hover();
        else await page.mouse.move(point!.x, point!.y);
        break;
      case "fill":
        if (!target) throw new Error("fill needs a ref from preview_snapshot.");
        await this.showAgent("fill", target);
        await target.fill(args.text ?? "");
        break;
      case "type":
        if (target ?? point) {
          await this.showAgent("type", target ?? point);
          if (target) await target.click();
          else await page.mouse.click(point!.x, point!.y);
        }
        await page.keyboard.type(args.text ?? "");
        break;
      case "press":
        if (!args.key) throw new Error('press needs a key, such as "Enter" or "ControlOrMeta+a".');
        if (target) await target.focus();
        await page.keyboard.press(args.key);
        break;
      case "scroll":
        if (target && args.dy === undefined && args.dx === undefined) {
          await this.showAgent("scroll", target);
          break;
        }
        await this.showAgent("scroll", target ?? point);
        if (point) await page.mouse.move(point.x, point.y);
        else if (target) await target.hover();
        await page.mouse.wheel(args.dx ?? 0, args.dy ?? 0);
        break;
      case "select":
        if (!target) throw new Error("select needs a ref from preview_snapshot.");
        await this.showAgent("select", target);
        await target.selectOption(args.values ?? []);
        break;
      case "drag": {
        if (!target || !args.to_ref) throw new Error("drag needs a ref and a to_ref from preview_snapshot.");
        await this.showAgent("drag", target);
        await target.dragTo(ref(args.to_ref));
        break;
      }
      case "wait":
        if (args.text) await page.getByText(args.text).first().waitFor({ timeout: Math.min(args.ms ?? ACTION_TIMEOUT_MS, 30_000) });
        else await page.waitForTimeout(Math.min(args.ms ?? 1_000, 10_000));
        break;
    }
    if (args.submit) await page.keyboard.press("Enter");
    // Lets a click's navigation, re-render and console output land before the agent looks again.
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(ACTION_SETTLE_MS);
  }

  /** REPL semantics, as in DevTools' console: top-level await, and the last expression is the result. */
  async evaluate(code: string): Promise<unknown> {
    this.touch();
    const cdp = await this.cdp;
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression: code, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    // A DOM node or a function has no JSON value, only a description.
    return result.value ?? result.description ?? result.type;
  }

  async responseBody(id: number): Promise<string> {
    const response = this.responses.get(id);
    if (!response) throw new Error(`No response with id ${id}. Ids come from preview_logs with source "network".`);
    return response.text();
  }

  close(because: string | null = null) {
    if (sessions.get(this.conversationId) !== this) return;
    sessions.delete(this.conversationId);
    const url = this.page?.url();
    closedPages.set(this.conversationId, { url: url && url !== "about:blank" ? url : (closedPages.get(this.conversationId)?.url ?? null), because });
    void this.context.close().catch(() => {});
    closeBrowserIfUnused();
    this.changed();
  }
}

export type ActAction = "click" | "double_click" | "right_click" | "hover" | "fill" | "type" | "press" | "scroll" | "select" | "drag" | "wait";

export interface ActArgs {
  action: ActAction;
  ref?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  values?: string[];
  dx?: number;
  dy?: number;
  to_ref?: string;
  ms?: number;
  submit?: boolean;
}

export function getSession(conversationId: string): PreviewSession | undefined {
  return sessions.get(conversationId);
}

/** The chat's page, opened on first use. */
export async function openSession(conversationId: string): Promise<PreviewSession> {
  const existing = sessions.get(conversationId);
  if (existing) return existing;
  let pending = opening.get(conversationId);
  if (!pending) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].filter((s) => !s.watched).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      oldest?.close(CLOSED_BECAUSE.full);
    }
    pending = PreviewSession.open(conversationId).then((session) => {
      sessions.set(conversationId, session);
      return session;
    });
    opening.set(conversationId, pending);
    void pending.finally(() => opening.delete(conversationId)).catch(() => {});
  }
  return pending;
}

export function closedPage(conversationId: string): { url: string | null; because: string | null } {
  return closedPages.get(conversationId) ?? { url: null, because: null };
}

/** The pane that resized last decides the page's size, so it moves to the end. */
export async function setPane(viewer: Viewer, pane: NonNullable<Viewer["pane"]>) {
  viewer.pane = pane;
  const set = viewers.get(viewer.conversationId);
  set?.delete(viewer);
  set?.add(viewer);
  await sessions.get(viewer.conversationId)?.applyViewport();
}

export async function addViewer(viewer: Viewer) {
  const set = viewers.get(viewer.conversationId) ?? new Set<Viewer>();
  set.add(viewer);
  viewers.set(viewer.conversationId, set);
  const session = sessions.get(viewer.conversationId);
  if (!session) return;
  await session.applyViewport();
  await session.syncScreencast();
  await session.sendCurrentFrame([viewer]);
}

export async function removeViewer(viewer: Viewer) {
  const set = viewers.get(viewer.conversationId);
  set?.delete(viewer);
  if (set?.size === 0) viewers.delete(viewer.conversationId);
  const session = sessions.get(viewer.conversationId);
  if (!session) return;
  await session.syncScreencast();
  if (set?.size) await session.applyViewport();
}

export function closeIdleSessions() {
  for (const session of sessions.values()) if (session.idle) session.close(CLOSED_BECAUSE.idle);
}

/** The local ports open pages show, which keeps their dev servers running. */
export function shownPorts(): Set<number> {
  return new Set([...sessions.values()].map((s) => s.localPort).filter((p): p is number => p !== null));
}
