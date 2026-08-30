type BootMonitor = {
  checkpoint(number: number, detail?: unknown): void;
  fail(title: string, detail: unknown): void;
  record(kind: string, detail: unknown): void;
};

declare global {
  interface Window {
    __QAGENT_BOOT__?: BootMonitor;
  }
}

window.__QAGENT_BOOT__?.checkpoint(2, "production ES module evaluated");

export {};
