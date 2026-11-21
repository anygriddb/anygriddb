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

// Says the page's language before the app does, for what the page shows
// while the app has not drawn (index.html). The same rule as lib/i18n.tsx:
// the language the person picked, or the first of the browser's that the
// app speaks, or English.
var spoken = null;
try {
  var picked = window.localStorage.getItem("ag_locale");
  if (picked === "fr" || picked === "en") spoken = picked;
} catch (error) {
  // Storage can be blocked: the browser's languages decide.
}
var asked =
  navigator.languages && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
for (var index = 0; spoken === null && index < asked.length; index += 1) {
  var tag = String(asked[index]).toLowerCase();
  if (tag === "fr" || tag.indexOf("fr-") === 0) spoken = "fr";
  else if (tag === "en" || tag.indexOf("en-") === 0) spoken = "en";
}
document.documentElement.lang = spoken || "en";
