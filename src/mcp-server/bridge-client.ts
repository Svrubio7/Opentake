// Talks to the running OpenTake app over its local bridge (src/main/mcp/bridge.ts): 127.0.0.1 only, the
// per-install token from the app's data folder on every request. Captions (the speech model runs in
// the app) and exports (the app's own export, with its progress on screen) go through here. When the
// app is closed and a tool needs it, the app is started in the background, with no window.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { BACKGROUND_FLAG, BRIDGE_FILE, TOKEN_FILE, TOKEN_HEADER, type BridgeFile, type BridgeMethod } from "../shared/assistant";

const read = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return null; } };

export class AppNotRunning extends Error {}

export class Bridge {
  constructor(readonly userData: string, private env = process.env) {}

  private target(): (BridgeFile & { token: string }) | null {
    const raw = read(join(this.userData, BRIDGE_FILE));
    const token = read(join(this.userData, TOKEN_FILE))?.trim();
    if (!raw || !token) return null;
    try {
      const b = JSON.parse(raw) as BridgeFile;
      return Number.isInteger(b.port) && b.port > 0 && b.port < 65536 ? { ...b, token } : null;
    } catch { return null; }
  }

  /** One call; throws AppNotRunning when nothing answers. */
  call<T = unknown>(method: BridgeMethod, params: unknown = {}, timeoutMs = 15_000): Promise<T> {
    const t = this.target();
    if (!t) return Promise.reject(new AppNotRunning("OpenTake is not running"));
    const body = JSON.stringify({ method, params });
    return new Promise<T>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: t.port, path: "/rpc", method: "POST", timeout: timeoutMs,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), [TOKEN_HEADER]: t.token },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; result?: T; error?: string };
            if (j.ok) resolve(j.result as T);
            else reject(new Error(j.error ?? "OpenTake could not do that"));
          } catch { reject(new Error(`OpenTake answered ${res.statusCode}`)); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("OpenTake did not answer in time")));
      req.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ECONNREFUSED" || e.code === "ECONNRESET" ? new AppNotRunning("OpenTake is not running") : e));
      req.end(body);
    });
  }

  async running(): Promise<boolean> {
    try { await this.call("ping", {}, 3000); return true; } catch { return false; }
  }

  /** How to start the app from here: the executable this server runs on (OpenTake itself, or Electron in dev). */
  launchCommand(): { command: string; args: string[] } {
    if (this.env.OPENTAKE_APP_COMMAND) {
      const parsed = JSON.parse(this.env.OPENTAKE_APP_COMMAND) as string[];
      return { command: parsed[0], args: [...parsed.slice(1), BACKGROUND_FLAG] };
    }
    const root = this.env.OPENTAKE_APP_ROOT;
    const userDataArg = this.env.OPENTAKE_USER_DATA ? [`--user-data-dir=${this.userData}`] : [];
    return { command: process.execPath, args: [...(root ? [root] : []), BACKGROUND_FLAG, ...userDataArg] };
  }

  /** The app, started in the background if it is closed. Resolves once its bridge answers. */
  async ensure(waitMs = 45_000): Promise<void> {
    if (await this.running()) return;
    if (this.env.OPENTAKE_NO_LAUNCH === "1") throw new AppNotRunning("OpenTake is not running. Open it and try again.");
    const { command, args } = this.launchCommand();
    const env = { ...this.env };
    delete env.ELECTRON_RUN_AS_NODE; // or it would start as Node again
    const child = spawn(command, args, { detached: true, stdio: "ignore", env, windowsHide: true });
    child.on("error", () => { /* reported below as a timeout */ });
    child.unref();
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.running()) return;
    }
    throw new AppNotRunning("OpenTake did not start. Open it yourself and try again.");
  }
}
