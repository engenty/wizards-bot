/**
 * Light or dark as the system has it, also when it changes while the page is open. index.html
 * sets the class before the first paint; this keeps it.
 */
export function followSystemTheme() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", dark.matches);
  apply();
  dark.addEventListener("change", apply);
}
