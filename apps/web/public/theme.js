// Applies the stored theme before the first paint. The same rule as
// lib/theme.tsx, which takes over once the app has loaded.
try {
  var stored = window.localStorage.getItem("ag_theme");
  var dark =
    stored === "dark" ||
    (stored !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch (error) {
  // Storage can be blocked: the app applies the system theme itself.
}
