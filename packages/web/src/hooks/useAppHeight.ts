import { useEffect } from "react";

/**
 * Sizes the app to the visible part of the screen in an iOS home-screen app,
 * via --app-height, and marks <html data-keyboard> while the keyboard is up.
 * There 100dvh can launch short of the screen and never shrinks for the
 * keyboard, so iOS pans the page and hides the top of the chat.
 */
export function useAppHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !matchMedia("(display-mode: standalone)").matches) return;
    const html = document.documentElement;
    const sync = () => {
      // iOS reports screen in portrait whichever way the phone is held.
      const [short, long] = [screen.width, screen.height].sort((a, b) => a - b);
      const screenHeight = innerWidth > innerHeight ? short : long;
      const visible = vv.height * vv.scale;
      const keyboard = visible < screenHeight * 0.75;
      html.style.setProperty("--app-height", keyboard ? `${visible}px` : "100lvh");
      html.toggleAttribute("data-keyboard", keyboard);
      if (keyboard) window.scrollTo(0, 0);
    };
    sync();
    // iOS pans the page to the input while the keyboard slides in, after the resize too.
    for (const e of ["resize", "scroll"]) vv.addEventListener(e, sync);
    return () => {
      for (const e of ["resize", "scroll"]) vv.removeEventListener(e, sync);
      html.style.removeProperty("--app-height");
      html.removeAttribute("data-keyboard");
    };
  }, []);
}
