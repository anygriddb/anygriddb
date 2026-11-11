/** Default matches the former Tailwind `w-60` (15rem at 16px). */
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
const STORAGE_KEY = "ag_sidebar_width";

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.round(
    Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, width)),
  );
}

export function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function writeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Storage can be blocked; the width still applies to this page.
  }
}
