(function () {
  "use strict";
  var theme = "light";
  try {
    var stored = localStorage.getItem("agent-bus.theme");
    if (stored === "dark" || stored === "evil") theme = stored;
  } catch (_ignore) {}
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
  try {
    if (localStorage.getItem("agent-bus.nav-hidden") === "1") {
      document.documentElement.classList.add("nav-hidden");
    }
  } catch (_nav) {}
})();
