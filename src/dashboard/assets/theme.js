"use strict";

(() => {
  const root = document.documentElement;
  const button = document.querySelector("[data-theme-toggle]");
  if (!button) return;

  function showTheme() {
    const dark = root.dataset.theme === "dark";
    button.textContent = dark ? "浅色模式" : "深色模式";
    button.setAttribute("aria-label", dark ? "切换为浅色模式" : "切换为深色模式");
    button.setAttribute("aria-pressed", String(dark));
  }

  button.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("offergo:theme", next); } catch {}
    showTheme();
  });
  showTheme();
})();
