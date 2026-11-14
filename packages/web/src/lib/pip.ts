// Picture in picture for the preview. Chromium and Firefox on a computer open a real window that stays on top
// (Document Picture-in-Picture) and hold the whole pane. Safari has no such window, so it gets the next best:
// the stream as a video in its own PiP, to watch but not to use.

interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

interface WebkitVideo extends HTMLVideoElement {
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture") => void;
  webkitPresentationMode?: "inline" | "picture-in-picture" | "fullscreen";
}

export const documentPip = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture ?? null;

export const videoPip = document.pictureInPictureEnabled || "webkitSetPresentationMode" in HTMLVideoElement.prototype;

/** What the pop-out button does here, or null where neither kind works. */
export const pipKind: "window" | "video" | null = documentPip ? "window" : videoPip ? "video" : null;

/** The new window starts blank, so it gets the app's styles: linked sheets by URL, inline ones by their rules. */
export function copyStyles(from: Document, to: Document) {
  for (const sheet of Array.from(from.styleSheets)) {
    if (sheet.href) {
      const link = to.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      to.head.append(link);
      continue;
    }
    const style = to.createElement("style");
    style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
    to.head.append(style);
  }
  to.documentElement.className = from.documentElement.className;
  to.body.className = from.body.className;
}

/** Toggles the video's own PiP. Called straight from the click, as Safari only allows it during the gesture. */
export async function toggleVideoPip(video: HTMLVideoElement) {
  const v = video as WebkitVideo;
  if (document.pictureInPictureElement) return document.exitPictureInPicture();
  if (v.webkitPresentationMode === "picture-in-picture") return v.webkitSetPresentationMode?.("inline");
  if (document.pictureInPictureEnabled) return void (await v.requestPictureInPicture());
  v.webkitSetPresentationMode?.("picture-in-picture");
}
