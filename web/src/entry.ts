type BootMonitor = {
  checkpoint(number: number, detail?: unknown): void;
  fail(title: string, detail: unknown): void;
  record(kind: string, detail: unknown): void;
};

declare global {
  interface Window {
    __AGENT_BUS_BOOT__?: BootMonitor;
  }
}

window.__AGENT_BUS_BOOT__?.checkpoint(2, "production ES module evaluated");

export {};
