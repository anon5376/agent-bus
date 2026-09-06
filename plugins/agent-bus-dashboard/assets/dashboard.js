(function () {
  "use strict";

  var root = document.documentElement;
  var body = document.body;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var narrow = window.matchMedia("(max-width: 900px)");

  if (!reduceMotion) {
    root.classList.add("motion-ready");
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        root.classList.add("is-ready");
        window.setTimeout(function () { root.classList.remove("motion-ready", "is-ready"); }, 520);
      });
    });
  }

  /* ---------- theme ---------- */

  function applyTheme(theme) {
    if (theme !== "dark" && theme !== "evil") theme = "light";
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme === "light" ? "light" : "dark";
    document.querySelectorAll("[data-theme-set]").forEach(function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-theme-set") === theme ? "true" : "false");
    });
    try { localStorage.setItem("agent-bus.theme", theme); } catch (_ignore) {}
  }
  applyTheme((function () {
    try { return localStorage.getItem("agent-bus.theme"); } catch (_ignore) { return "light"; }
  })());
  document.querySelectorAll("[data-theme-set]").forEach(function (button) {
    button.addEventListener("click", function () { applyTheme(button.getAttribute("data-theme-set")); });
  });

  /* ---------- dock (project rail) ---------- */

  var navToggle = document.querySelector("[data-nav-toggle]");
  var projectMenu = document.querySelector("[data-project-menu]");
  var dockScroll = document.getElementById("sidebar-scroll");
  var dockFoot = document.querySelector(".dock-foot");
  var scrim = document.querySelector("[data-dock-scrim]");

  function setInert(hidden) {
    [dockScroll, dockFoot].forEach(function (region) {
      if (!region) return;
      region.inert = hidden;
      region.setAttribute("aria-hidden", hidden ? "true" : "false");
    });
  }

  function applyNavHidden(hidden, persist) {
    root.classList.toggle("nav-hidden", hidden);
    body.classList.toggle("nav-hidden", hidden);
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", hidden ? "false" : "true");
      navToggle.setAttribute("aria-label", hidden ? "Show project dock" : "Hide project dock");
      navToggle.title = hidden ? "Show project dock" : "Hide project dock";
    }
    setInert(hidden);
    if (persist) {
      try { localStorage.setItem("agent-bus.nav-hidden", hidden ? "1" : "0"); } catch (_ignore) {}
    }
  }

  function setDrawer(open) {
    body.classList.toggle("dock-open", open);
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
      navToggle.setAttribute("aria-label", open ? "Close project dock" : "Open project dock");
    }
    setInert(!open);
    if (open && dockScroll) {
      var first = dockScroll.querySelector("input, a, button, summary");
      if (first) first.focus({ preventScroll: true });
    }
  }

  function syncDockMode() {
    if (narrow.matches) {
      root.classList.remove("nav-hidden");
      body.classList.remove("nav-hidden");
      setDrawer(false);
      return;
    }
    body.classList.remove("dock-open");
    var hidden = false;
    try { hidden = localStorage.getItem("agent-bus.nav-hidden") === "1"; } catch (_ignore) {}
    applyNavHidden(hidden, false);
  }

  try {
    if (projectMenu && localStorage.getItem("agent-bus.project-menu-open") === "0") projectMenu.open = false;
  } catch (_storage) {}
  syncDockMode();
  if (narrow.addEventListener) narrow.addEventListener("change", syncDockMode);
  else if (narrow.addListener) narrow.addListener(syncDockMode);
  window.requestAnimationFrame(function () {
    window.requestAnimationFrame(function () { root.classList.add("nav-motion"); });
  });

  if (navToggle) {
    navToggle.addEventListener("click", function () {
      if (narrow.matches) setDrawer(!body.classList.contains("dock-open"));
      else applyNavHidden(!root.classList.contains("nav-hidden"), true);
    });
  }
  if (scrim) scrim.addEventListener("click", function () { setDrawer(false); });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && body.classList.contains("dock-open")) {
      setDrawer(false);
      if (navToggle) navToggle.focus();
    }
  });
  if (projectMenu) {
    projectMenu.addEventListener("toggle", function () {
      try { localStorage.setItem("agent-bus.project-menu-open", projectMenu.open ? "1" : "0"); } catch (_ignore) {}
    });
  }

  /* ---------- in-page filters ---------- */

  var search = document.querySelector("[data-search]");
  if (search) {
    var filterCount = document.querySelector("[data-filter-count]");
    var applyFilter = function () {
      var query = search.value.trim().toLowerCase();
      var shown = 0;
      var total = 0;
      document.querySelectorAll("[data-filter-text]").forEach(function (row) {
        total += 1;
        var hit = query.length === 0 || (row.dataset.filterText || "").indexOf(query) !== -1;
        row.hidden = !hit;
        if (hit) shown += 1;
      });
      if (filterCount) filterCount.textContent = query.length ? shown + " of " + total + " shown" : "";
      document.querySelectorAll("[data-filter-empty]").forEach(function (empty) {
        empty.hidden = !(query.length && shown === 0);
      });
    };
    search.addEventListener("input", applyFilter);
    if (search.value) applyFilter();
  }

  var projectSearchers = document.querySelectorAll("[data-project-search]");
  var projectItems = document.querySelectorAll("[data-project-item]");
  function applyProjectQuery(query) {
    query = query.trim().toLowerCase();
    var visible = 0;
    var counted = {};
    projectItems.forEach(function (row) {
      var inHidden = Boolean(row.closest("[data-hidden-bay]"));
      var match = query.length === 0 || (row.dataset.filterText || "").indexOf(query) !== -1;
      row.hidden = !match;
      var key = row.dataset.projectKey || "";
      if (match && key && !counted[key] && (query.length > 0 || !inHidden)) {
        counted[key] = true;
        visible += 1;
      }
    });
    document.querySelectorAll("[data-project-bay]").forEach(function (bay) {
      var any = bay.querySelector("[data-project-item]:not([hidden])");
      var hint = bay.querySelector(".bay-empty");
      if (hint) hint.hidden = query.length > 0;
      bay.hidden = !any && !(hint && query.length === 0);
      if (bay.hasAttribute("data-hidden-bay") && query.length > 0) bay.open = Boolean(any);
    });
    document.querySelectorAll("[data-project-empty]").forEach(function (empty) { empty.hidden = visible > 0; });
    document.querySelectorAll("[data-project-count]").forEach(function (el) { el.textContent = String(visible); });
  }
  projectSearchers.forEach(function (input) {
    input.addEventListener("input", function () {
      projectSearchers.forEach(function (other) { if (other !== input) other.value = input.value; });
      applyProjectQuery(input.value);
    });
  });

  /* ---------- clipboard, confirmations, submit feedback ---------- */

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
      if (form.hasAttribute("data-project-pin") || form.hasAttribute("data-project-hide")) return;
      var button = form.querySelector('button[type="submit"]');
      if (!button) return;
      button.disabled = true;
      button.classList.add("is-loading");
      button.textContent = "Working…";
    });
  });

  /* ---------- live status + usage monitor ---------- */

  var usageMonitor = document.querySelector("[data-usage-monitor]");
  if (usageMonitor) {
    var usageStatus = usageMonitor.querySelector("[data-usage-status]");
    var subscriptions = usageMonitor.querySelector("[data-usage-subscriptions]");
    var brokerPill = document.querySelector("[data-broker-state]");

    function count(value) { return Math.max(0, Math.round(Number(value) || 0)).toLocaleString(); }
    function cost(value) { return "$" + Math.max(0, Number(value) || 0).toFixed(4); }
    function statusText(text) { if (usageStatus) usageStatus.textContent = text; }

    function updateText(selector, value, scope) {
      var element = (scope || document).querySelector(selector);
      if (!element || element.textContent === value) return;
      element.textContent = value;
      if (reduceMotion) return;
      element.classList.remove("value-changed");
      void element.offsetWidth;
      element.classList.add("value-changed");
      element.addEventListener("animationend", function () { element.classList.remove("value-changed"); }, { once: true });
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
      var totalTokens = groups.reduce(function (sum, group) { return sum + (Number(group.tokens) || 0); }, 0);
      groups.forEach(function (group) {
        var row = document.createElement("div");
        row.className = "usage-row";
        var identity = document.createElement("div");
        identity.className = "usage-name";
        var name = document.createElement("strong");
        name.textContent = group.name;
        var agents = document.createElement("span");
        agents.textContent = (group.labels || group.agents).join(", ");
        agents.title = group.agents.join(", ");
        identity.append(name, agents);
        row.appendChild(identity);
        var share = document.createElement("div");
        share.className = "usage-share";
        var meter = document.createElement("meter");
        var fraction = totalTokens > 0 ? (Number(group.tokens) || 0) / totalTokens : 0;
        meter.min = 0; meter.max = 1; meter.value = fraction;
        meter.setAttribute("aria-label", "Share of tokens");
        var pct = document.createElement("small");
        pct.textContent = Math.round(fraction * 100) + "%";
        share.append(meter, pct);
        row.appendChild(share);
        [count(group.turns), count(group.tokens), cost(group.costUSD)].forEach(function (value) {
          var item = document.createElement("span");
          item.className = "num";
          item.textContent = value;
          row.appendChild(item);
        });
        subscriptions.appendChild(row);
      });
    }

    function renderAgentRow(row, agent) {
      var usage = agent.usage || {};
      updateText('[data-agent-usage="tokens"]', count(usage.tokens) + " tokens", row);
      updateText('[data-agent-usage="turns"]', count(usage.turns) + " turns", row);
      updateText('[data-agent-usage="cost"]', cost(usage.costUSD) + " equivalent", row);
      var status = String(agent.status || "unknown").toLowerCase();
      var pretty = status.replace(/_/g, " ");
      pretty = pretty.charAt(0).toUpperCase() + pretty.slice(1);
      var pill = row.querySelector("[data-agent-status]");
      if (pill) {
        var label = pill.querySelector("[data-agent-status-label]");
        if (label && label.textContent !== pretty) {
          Array.prototype.slice.call(pill.classList).forEach(function (name) { if (name.indexOf("status-") === 0) pill.classList.remove(name); });
          pill.classList.add("status-" + status.replace(/[^a-z0-9_]/g, "-"));
          label.textContent = pretty;
        }
      }
      var doing = row.querySelector("[data-agent-doing]");
      if (doing && agent.doing && doing.textContent !== agent.doing) doing.textContent = agent.doing;
      var seen = row.querySelector("[data-agent-seen]");
      if (seen && agent.last_active) seen.textContent = agent.last_active;
      var pending = row.querySelector("[data-agent-pending]");
      if (pending) {
        var n = Number(agent.pending_messages) || 0;
        pending.hidden = n === 0;
        pending.textContent = n + " pending message" + (n === 1 ? "" : "s");
      }
    }

    function renderUsage(payload) {
      var rows = Array.from(document.querySelectorAll("[data-agent-id]"));
      var currentIds = rows.map(function (row) { return row.dataset.agentId; }).sort();
      var freshIds = (payload.agents || []).map(function (agent) { return agent.id; }).sort();
      if (currentIds.join("\n") !== freshIds.join("\n")) {
        statusText("Roster changed · refresh to see it");
        return;
      }
      var currentControls = rows.map(function (row) { return row.dataset.agentId + "|" + row.dataset.agentControlSignature; }).sort();
      var freshControls = (payload.agents || []).map(function (agent) {
        return agent.id + "|" + Number(Boolean(agent.session_available)) + "|" + Number(Boolean(agent.controllable));
      }).sort();
      if (currentControls.join("\n") !== freshControls.join("\n")) {
        statusText("Agent controls changed · refresh to see them");
        return;
      }
      var summary = payload.usage || { total: {}, subscriptions: [] };
      updateText('[data-usage-total="turns"]', count(summary.total.turns));
      updateText('[data-usage-total="tokens"]', count(summary.total.tokens));
      updateText('[data-usage-total="cost"]', cost(summary.total.costUSD));
      renderSubscriptions(summary.subscriptions || []);
      (payload.agents || []).forEach(function (agent) {
        rows.forEach(function (row) { if (row.dataset.agentId === agent.id) renderAgentRow(row, agent); });
      });
      var stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      statusText("Live · updated " + stamp);
      if (brokerPill) brokerPill.dataset.brokerState = "connected";
    }

    function refreshUsage() {
      if (document.visibilityState === "hidden") return;
      fetch(usageMonitor.dataset.apiUrl, { headers: { Accept: "application/json" } })
        .then(function (response) {
          return response.json().then(function (payload) { payload.requestFailed = !response.ok; return payload; });
        })
        .then(function (payload) {
          if (!payload.requestFailed) { renderUsage(payload); return; }
          var lastConfirmed = payload.lastObserved
            ? new Date(payload.lastObserved).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
            : "not available";
          statusText("Update paused · last confirmed " + lastConfirmed);
          if (brokerPill) brokerPill.dataset.brokerState = "disconnected";
        })
        .catch(function () { statusText("Update paused · broker unavailable"); });
    }

    window.setInterval(refreshUsage, 10000);
    document.addEventListener("visibilitychange", refreshUsage);
  }

  /* ---------- composer ---------- */

  document.querySelectorAll("details.compose").forEach(function (details) {
    details.addEventListener("toggle", function () { details.classList.toggle("is-open", details.open); });
  });

  /* ---------- keyboard ---------- */

  var projectKey = document.body.dataset.project;
  var chord = "";
  var chordTimer = null;
  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    var target = event.target;
    var editing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
    var activeSearch = search || document.querySelector(".register [data-project-search]") || document.querySelector("[data-project-search]");
    if (event.key === "/" && !editing && activeSearch) {
      event.preventDefault();
      if (activeSearch.closest(".dock") && narrow.matches) setDrawer(true);
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
    if (projectKey && key === "o") window.location.assign("/project/" + projectKey);
    if (projectKey && key === "a") window.location.assign("/project/" + projectKey + "/agents");
    if (projectKey && key === "m") window.location.assign("/project/" + projectKey + "/messages");
  });
})();
