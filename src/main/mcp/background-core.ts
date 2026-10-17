// What a background start (the assistant, no window) leaves out. Pure, tested in background-core.test.ts.
// Started for the assistant, the app only answers the bridge: no global shortcuts, no hooks, nothing a
// recording needs. All of that is registered once, when a window first opens (at once in a normal start).

export interface Session {
  /** the window is about to open: register the recording session's parts now (once) */
  windowOpening(): void;
  /** the session's parts are registered */
  readonly started: boolean;
}

export function sessionGate(background: boolean, register: () => void): Session {
  let started = false;
  const start = () => { if (started) return; started = true; register(); };
  if (!background) start();
  return { windowOpening: start, get started() { return started; } };
}
