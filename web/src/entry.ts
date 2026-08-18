const root = document.getElementById("root");
let showingFailure = false;

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function showBootFailure(title: string, detail: unknown): void {
  if (showingFailure || !root) return;
  showingFailure = true;
  const card = document.createElement("main");
  card.className = "boot-failure";
  const heading = document.createElement("h1");
  heading.textContent = title;
  const message = document.createElement("p");
  message.textContent = errorMessage(detail);
  const hint = document.createElement("p");
  hint.className = "boot-hint";
  hint.textContent = "Run `agent-bus open` again. If this persists, check ~/.agent-bus/broker.log and browser site JavaScript permissions.";
  card.append(heading, message, hint);
  root.replaceChildren(card);
  (globalThis as any).__AGENT_BUS_BOOTSTRAP__ = { phase: "failed", error: message.textContent };
}

(globalThis as any).__AGENT_BUS_BOOTSTRAP__ = { phase: "entry-loaded" };

window.onerror = (_message, _source, _line, _column, error) => {
  showBootFailure("Agent Bus frontend failed", error ?? _message);
  return false;
};

window.addEventListener("unhandledrejection", (event) => {
  showBootFailure("Agent Bus frontend promise failed", event.reason);
});

try {
  import("./main.tsx")
    .then(() => {
      (globalThis as any).__AGENT_BUS_BOOTSTRAP__ = { phase: "react-module-loaded" };
      window.setTimeout(() => {
        if (document.getElementById("agent-bus-boot")) {
          showBootFailure("Agent Bus frontend did not mount", "The React module loaded but did not replace the boot screen.");
        } else {
          (globalThis as any).__AGENT_BUS_BOOTSTRAP__ = { phase: "mounted" };
        }
      }, 1200);
    })
    .catch((error) => showBootFailure("Agent Bus frontend module failed to load", error));
} catch (error) {
  showBootFailure("Agent Bus frontend bootstrap failed", error);
}
