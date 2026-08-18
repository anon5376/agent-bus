(function () {
  "use strict";

  var labels = [
    "index HTML loaded",
    "entry module loaded",
    "app module imported",
    "React runtime loaded",
    "createRoot called",
    "render called",
    "first React component executed",
    "ticket exchange started",
    "ticket exchange completed",
    "dashboard mounted"
  ];
  var state = {
    version: 2,
    highest: 0,
    failed: false,
    stages: [],
    events: [],
    runtime: null,
    startedAt: Date.now()
  };

  function text(value) {
    if (value instanceof Error) return value.stack || value.message || value.name;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  function record(kind, detail) {
    state.events.push({ at: Date.now(), kind: kind, detail: text(detail) });
    if (state.events.length > 80) state.events.shift();
  }

  function stageNode(number) {
    return document.querySelector('[data-boot-stage="' + number + '"]');
  }

  function renderRuntime() {
    var node = document.getElementById("agent-bus-runtime");
    if (!node || !state.runtime) return;
    var runtime = state.runtime.runtime || state.runtime;
    var ui = runtime.ui || {};
    var scripts = ui.scripts || [];
    node.textContent = [
      "build " + (state.runtime.buildId || runtime.buildId || "unknown"),
      "pid " + (runtime.pid || state.runtime.pid || "unknown"),
      "app " + (runtime.applicationRoot || "unknown"),
      "static " + (runtime.staticRoot || "unknown"),
      "script " + (scripts[0] ? scripts[0].url + " · " + scripts[0].sha256.slice(0, 12) : "unknown")
    ].join("\n");
  }

  function checkpoint(number, detail) {
    number = Number(number);
    if (!number || number < 1 || number > labels.length) return;
    state.highest = Math.max(state.highest, number);
    state.stages[number - 1] = { at: Date.now(), detail: text(detail || labels[number - 1]) };
    record("checkpoint-" + number, detail || labels[number - 1]);
    var node = stageNode(number);
    if (node) {
      node.setAttribute("data-status", "passed");
      var detailNode = node.querySelector("small");
      if (detailNode && detail) detailNode.textContent = text(detail);
    }
    if (number === 10) {
      document.documentElement.setAttribute("data-agent-bus-mounted", "true");
    }
  }

  function failureCard(title, detail) {
    var root = document.getElementById("root") || document.body;
    var card = document.createElement("main");
    card.className = "boot-failure";
    var heading = document.createElement("h1");
    heading.textContent = title;
    var message = document.createElement("pre");
    message.className = "boot-error-detail";
    message.textContent = text(detail);
    var progress = document.createElement("p");
    progress.textContent = "Last completed checkpoint: " + state.highest + "/10" + (state.highest ? " · " + labels[state.highest - 1] : "");
    var hint = document.createElement("p");
    hint.className = "boot-hint";
    hint.textContent = "Run `agent-bus runtime --json` to inspect the exact launcher, checkout, PID, static root, and served asset hashes.";
    var runtime = document.createElement("pre");
    runtime.className = "boot-runtime";
    runtime.textContent = state.runtime ? JSON.stringify(state.runtime, null, 2) : "Runtime metadata request did not complete.";
    card.appendChild(heading);
    card.appendChild(message);
    card.appendChild(progress);
    card.appendChild(hint);
    card.appendChild(runtime);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(card);
  }

  function fail(title, detail) {
    if (state.failed || state.highest >= 10) return;
    state.failed = true;
    record("failure", title + ": " + text(detail));
    failureCard(title, detail);
  }

  window.__AGENT_BUS_BOOT__ = {
    state: state,
    checkpoint: checkpoint,
    fail: fail,
    record: record
  };

  checkpoint(1, "HTML and classic boot monitor executed");

  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && target.tagName) {
      var url = target.src || target.href || target.tagName;
      fail("Agent Bus resource failed to load", url);
      return;
    }
    fail("Agent Bus JavaScript error", event.error || event.message || "unknown script error");
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    fail("Agent Bus promise rejected", event.reason || "unknown rejection");
  });

  window.addEventListener("securitypolicyviolation", function (event) {
    fail("Agent Bus Content Security Policy violation", [
      event.violatedDirective,
      event.blockedURI,
      event.sourceFile,
      event.lineNumber + ":" + event.columnNumber
    ].join(" · "));
  });

  window.addEventListener("pageshow", function (event) {
    record("pageshow", event.persisted ? "restored from back-forward cache" : "normal navigation");
  });

  fetch("/diagnostics/runtime?boot=" + Date.now(), {
    credentials: "same-origin",
    headers: { "cache-control": "no-cache" }
  }).then(function (response) {
    return response.text().then(function (body) {
      if (!response.ok) throw new Error("runtime endpoint returned " + response.status + ": " + body.slice(0, 500));
      state.runtime = JSON.parse(body);
      record("runtime", state.runtime.buildId || "runtime metadata loaded");
      renderRuntime();
    });
  }).catch(function (error) {
    record("runtime-error", error);
  });

  window.setTimeout(function () {
    if (state.highest < 10 && !state.failed) {
      var resources = [];
      try {
        resources = performance.getEntriesByType("resource").map(function (entry) {
          return entry.name + " (" + Math.round(entry.duration) + "ms)";
        });
      } catch (_) {}
      fail("Agent Bus boot timed out", "Completed " + state.highest + "/10 checkpoints. Resources:\n" + resources.join("\n"));
    }
  }, 12000);
})();
