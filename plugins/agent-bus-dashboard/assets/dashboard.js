(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion) {
    root.classList.add("motion-ready");
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        root.classList.add("is-ready");
        window.setTimeout(function () {
          root.classList.remove("motion-ready", "is-ready");
        }, 620);
      });
    });
  }

  function applyTheme(theme) {
    if (theme !== "dark" && theme !== "evil") theme = "light";
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
    document.querySelectorAll("[data-theme-set]").forEach(function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-theme-set") === theme ? "true" : "false");
    });
    try { localStorage.setItem("agent-bus.theme", theme); } catch (_ignore) {}
  }
  applyTheme((function () {
    try { return localStorage.getItem("agent-bus.theme"); } catch (_ignore) { return "light"; }
  })());
  document.querySelectorAll("[data-theme-set]").forEach(function (button) {
    button.addEventListener("click", function () {
      applyTheme(button.getAttribute("data-theme-set"));
    });
  });

  var navToggle = document.querySelector("[data-nav-toggle]");
  var projectMenu = document.querySelector("[data-project-menu]");
  var sidebarScroll = document.getElementById("sidebar-scroll");
  var sidebarFoot = document.querySelector(".sidebar-foot");

  function applyNavHidden(hidden, persist) {
    document.documentElement.classList.toggle("nav-hidden", hidden);
    document.body.classList.toggle("nav-hidden", hidden);
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", hidden ? "false" : "true");
      navToggle.textContent = hidden ? "Show" : "Hide";
    }
    if (sidebarScroll) {
      sidebarScroll.inert = hidden;
      sidebarScroll.setAttribute("aria-hidden", hidden ? "true" : "false");
    }
    if (sidebarFoot) {
      sidebarFoot.inert = hidden;
      sidebarFoot.setAttribute("aria-hidden", hidden ? "true" : "false");
    }
    if (persist) {
      try { localStorage.setItem("agent-bus.nav-hidden", hidden ? "1" : "0"); } catch (_ignore) {}
    }
  }

  var navHidden = document.documentElement.classList.contains("nav-hidden");
  try {
    if (!navHidden && localStorage.getItem("agent-bus.nav-hidden") === "1") navHidden = true;
    if (projectMenu && localStorage.getItem("agent-bus.project-menu-open") === "0") {
      projectMenu.open = false;
    }
  } catch (_storage) {}
  applyNavHidden(navHidden, false);
  window.requestAnimationFrame(function () {
    window.requestAnimationFrame(function () {
      document.documentElement.classList.add("nav-motion");
    });
  });
  if (navToggle) {
    navToggle.addEventListener("click", function () {
      applyNavHidden(!document.documentElement.classList.contains("nav-hidden"), true);
    });
  }
  if (projectMenu) {
    projectMenu.addEventListener("toggle", function () {
      try { localStorage.setItem("agent-bus.project-menu-open", projectMenu.open ? "1" : "0"); } catch (_ignore) {}
    });
  }

  var search = document.querySelector("[data-search]");
  if (search) {
    search.addEventListener("input", function () {
      var query = search.value.trim().toLowerCase();
      document.querySelectorAll("[data-filter-text]").forEach(function (row) {
        row.hidden = query.length > 0 && !row.dataset.filterText.includes(query);
      });
    });
  }

  var projectSearchers = document.querySelectorAll("[data-project-search]");
  var projectItems = document.querySelectorAll("[data-project-item]");
  function applyProjectQuery(query) {
    query = query.trim().toLowerCase();
    var visible = 0;
    var counted = {};
    projectItems.forEach(function (row) {
      var match = query.length === 0 || (row.dataset.filterText || "").indexOf(query) !== -1;
      row.hidden = !match;
      var key = row.dataset.projectKey || "";
      if (match && key && !counted[key]) {
        counted[key] = true;
        visible += 1;
      }
    });
    document.querySelectorAll("[data-project-bay]").forEach(function (bay) {
      var any = bay.querySelector("[data-project-item]:not([hidden])");
      var hint = bay.querySelector(".project-bay-empty");
      if (hint) hint.hidden = query.length > 0;
      bay.hidden = !any && !(hint && query.length === 0);
    });
    document.querySelectorAll("[data-project-empty]").forEach(function (empty) {
      empty.hidden = visible > 0;
    });
    document.querySelectorAll("[data-project-count]").forEach(function (el) {
      el.textContent = String(visible);
    });
  }
  projectSearchers.forEach(function (input) {
    input.addEventListener("input", function () {
      projectSearchers.forEach(function (other) {
        if (other !== input) other.value = input.value;
      });
      applyProjectQuery(input.value);
    });
  });

  document.querySelectorAll("[data-copy-target]").forEach(function (button) {
    button.addEventListener("click", function () {
      var target = document.getElementById(button.getAttribute("data-copy-target") || "");
      if (!target) return;
      var text = target.textContent || "";
      var previous = button.textContent;
      function done(ok) {
        button.textContent = ok ? "Copied" : "Copy failed";
        window.setTimeout(function () { button.textContent = previous; }, 1400);
      }
      function fallback() {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (_err) {}
        document.body.removeChild(area);
        done(ok);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }).catch(fallback);
        return;
      }
      fallback();
    });
  });

  document.querySelectorAll("form[data-confirm]").forEach(function (form) {
    form.addEventListener("submit", function (event) {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  document.querySelectorAll("form").forEach(function (form) {
    form.addEventListener("submit", function (event) {
      if (event.defaultPrevented) return;
      if (form.hasAttribute("data-project-pin")) return;
      var button = form.querySelector('button[type="submit"]');
      if (!button) return;
      button.disabled = true;
      button.classList.add("is-loading");
      button.textContent = "Working…";
    });
  });

  var usageMonitor = document.querySelector("[data-usage-monitor]");
  if (usageMonitor) {
    var usageStatus = usageMonitor.querySelector("[data-usage-status]");
    var subscriptions = usageMonitor.querySelector("[data-usage-subscriptions]");

    function count(value) {
      return Math.max(0, Math.round(Number(value) || 0)).toLocaleString();
    }

    function cost(value) {
      return "$" + Math.max(0, Number(value) || 0).toFixed(4);
    }

    function updateText(selector, value) {
      var element = document.querySelector(selector);
      if (!element || element.textContent === value) return;
      element.textContent = value;
      if (reduceMotion) return;
      element.classList.remove("value-changed");
      void element.offsetWidth;
      element.classList.add("value-changed");
      element.addEventListener("animationend", function () {
        element.classList.remove("value-changed");
      }, { once: true });
    }

    function renderSubscriptions(groups) {
      subscriptions.replaceChildren();
      if (!groups.length) {
        var empty = document.createElement("div");
        empty.className = "usage-empty";
        empty.textContent = "Usage appears after an attached agent completes a turn.";
        subscriptions.appendChild(empty);
        return;
      }
      groups.forEach(function (group) {
        var row = document.createElement("div");
        row.className = "usage-subscription";
        var identity = document.createElement("div");
        var name = document.createElement("strong");
        name.textContent = group.name;
        var agents = document.createElement("span");
        agents.textContent = group.agents.join(", ");
        identity.append(name, agents);
        [count(group.turns) + " turns", count(group.tokens) + " tokens", cost(group.costUSD) + " equivalent"].forEach(function (value) {
          var item = document.createElement("span");
          item.textContent = value;
          row.appendChild(item);
        });
        row.prepend(identity);
        subscriptions.appendChild(row);
      });
    }

    function renderUsage(payload) {
      var currentIds = Array.from(document.querySelectorAll("[data-agent-id]")).map(function (row) { return row.dataset.agentId; }).sort();
      var freshIds = (payload.agents || []).map(function (agent) { return agent.id; }).sort();
      if (currentIds.join("\n") !== freshIds.join("\n")) {
        usageStatus.textContent = "Roster changed · use Refresh";
        return;
      }
      var currentControls = Array.from(document.querySelectorAll("[data-agent-id]")).map(function (row) {
        return row.dataset.agentId + "|" + row.dataset.agentControlSignature;
      }).sort();
      var freshControls = (payload.agents || []).map(function (agent) {
        return agent.id + "|" + Number(Boolean(agent.session_available)) + "|" + Number(Boolean(agent.controllable));
      }).sort();
      if (currentControls.join("\n") !== freshControls.join("\n")) {
        usageStatus.textContent = "Agent controls changed · use Refresh";
        return;
      }
      var summary = payload.usage || { total: {}, subscriptions: [] };
      updateText('[data-usage-total="turns"]', count(summary.total.turns));
      updateText('[data-usage-total="tokens"]', count(summary.total.tokens));
      updateText('[data-usage-total="cost"]', cost(summary.total.costUSD));
      renderSubscriptions(summary.subscriptions || []);
      (payload.agents || []).forEach(function (agent) {
        document.querySelectorAll("[data-agent-id]").forEach(function (row) {
          if (row.dataset.agentId !== agent.id) return;
          var usage = agent.usage || {};
          var tokenValue = row.querySelector('[data-agent-usage="tokens"]');
          var turnValue = row.querySelector('[data-agent-usage="turns"]');
          var costValue = row.querySelector('[data-agent-usage="cost"]');
          if (tokenValue) tokenValue.textContent = count(usage.tokens) + " tokens";
          if (turnValue) turnValue.textContent = count(usage.turns) + " turns";
          if (costValue) costValue.textContent = cost(usage.costUSD) + " equivalent";
        });
      });
      usageStatus.textContent = "Live · updated now";
    }

    function refreshUsage() {
      if (document.visibilityState === "hidden") return;
      fetch(usageMonitor.dataset.apiUrl, { headers: { Accept: "application/json" } })
        .then(function (response) {
          return response.json().then(function (payload) {
            payload.requestFailed = !response.ok;
            return payload;
          });
        })
        .then(function (payload) {
          if (!payload.requestFailed) {
            renderUsage(payload);
            return;
          }
          var lastConfirmed = payload.lastObserved ? new Date(payload.lastObserved).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "not available";
          usageStatus.textContent = "Update paused · last confirmed " + lastConfirmed;
        })
        .catch(function () { usageStatus.textContent = "Update paused · broker unavailable"; });
    }

    window.setInterval(refreshUsage, 10000);
    document.addEventListener("visibilitychange", refreshUsage);
  }

  document.querySelectorAll("details.compose").forEach(function (details) {
    details.addEventListener("toggle", function () {
      details.classList.toggle("is-open", details.open);
    });
  });

  var projectKey = document.body.dataset.project;
  var chord = "";
  var chordTimer = null;

  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    var target = event.target;
    var editing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);

    var activeSearch = search || document.querySelector(".project-register [data-project-search]") || document.querySelector("[data-project-search]");
    if (event.key === "/" && !editing && activeSearch) {
      event.preventDefault();
      activeSearch.focus();
      return;
    }

    if (editing) return;
    if (event.key.toLowerCase() === "g") {
      chord = "g";
      clearTimeout(chordTimer);
      chordTimer = window.setTimeout(function () { chord = ""; }, 900);
      return;
    }

    if (chord !== "g") return;
    chord = "";
    clearTimeout(chordTimer);
    var key = event.key.toLowerCase();
    if (key === "p") window.location.assign("/");
    if (projectKey && key === "a") window.location.assign("/project/" + projectKey + "/agents");
    if (projectKey && key === "m") window.location.assign("/project/" + projectKey + "/messages");
  });
})();
