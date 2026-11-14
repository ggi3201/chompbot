import { useSyncExternalStore } from "react";

const query = "(max-width: 767px)";

function subscribe(cb: () => void) {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot() {
  return window.matchMedia(query).matches;
}

function getServerSnapshot() {
  return false;
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Touch screens: focusing a field there opens the on-screen keyboard. */
export const isTouch = window.matchMedia("(pointer: coarse)").matches;
