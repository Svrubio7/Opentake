// The app's side of the assistant bridge: a tiny HTTP server on 127.0.0.1 that the MCP server calls for
// what needs the app (captions, exports, refreshing an open editor). No Electron here; the app passes
// in the handlers (src/main/mcp/assistant.ts). Every request needs the per-install token, comes from this
// machine and is not from a web page: a browser cannot read the token, and anything with an Origin
// header or the wrong Host is refused.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { BRIDGE_FILE, TOKEN_FILE, TOKEN_HEADER, type AssistantJob, type BridgeFile, type BridgeMethod } from "../../shared/assistant";

export type Handlers = Partial<Record<BridgeMethod, (params: Record<string, unknown>) => Promise<unknown> | unknown>>;

const MAX_BODY = 256 * 1024;

/** The token on file, made once per install (32 random bytes, readable only by this user). */
export function readToken(userData: string): string {
  const file = join(userData, TOKEN_FILE);
  try {
    const t = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch { /* first run */ }
  return "";
}

async function makeToken(userData: string): Promise<string> {
  const have = readToken(userData);
  if (have) return have;
  const file = join(userData, TOKEN_FILE);
  await mkdir(dirname(file), { recursive: true });
  const t = randomBytes(32).toString("hex");
  await writeFile(file, t, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return t;
}

/** The request may come in: right token, our own host and port, no browser origin. Pure, tested. */
export function allowed(headers: IncomingMessage["headers"], token: string, port: number): { ok: true } | { ok: false; status: number; why: string } {
  if (headers.origin || headers["sec-fetch-site"] || headers["sec-fetch-mode"]) return { ok: false, status: 403, why: "web pages cannot use this" };
  const host = String(headers.host ?? "");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { ok: false, status: 403, why: "wrong host" };
  const got = headers[TOKEN_HEADER];
  if (typeof got !== "string" || got.length !== token.length || !token) return { ok: false, status: 401, why: "no token" };
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(token))) return { ok: false, status: 401, why: "wrong token" };
  return { ok: true };
}

/** Jobs the app runs for the assistant, kept for an hour after they finish. */
export class Jobs {
  private map = new Map<string, AssistantJob>();
  start(kind: AssistantJob["kind"], takeId: string): AssistantJob {
    this.sweep();
    const job: AssistantJob = { id: `app-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, kind, takeId, stage: "Starting", ratio: null, done: false, startedAt: Date.now() };
    this.map.set(job.id, job);
    return job;
  }
  get(id: string) { return this.map.get(id); }
  running() { return [...this.map.values()].filter((j) => !j.done).length; }
  finish(job: AssistantJob, r: { output?: string[]; error?: string }) {
    Object.assign(job, { done: true, ratio: r.error ? job.ratio : 1, stage: r.error ? "Failed" : "Done", finishedAt: Date.now(), ...r });
  }
  private sweep() {
    const old = Date.now() - 3_600_000;
    for (const [id, j] of this.map) if (j.done && (j.finishedAt ?? 0) < old) this.map.delete(id);
  }
}

export interface BridgeHandle { port: number; close: () => Promise<void>; lastUsed: () => number; /** at quit: the bridge file goes now, synchronously */ forget: () => void }

/** Starts the bridge on a random port and writes the bridge file the MCP server reads. */
export async function startBridge(o: { userData: string; version: string; handlers: Handlers }): Promise<BridgeHandle> {
  const token = await makeToken(o.userData);
  let lastUsed = Date.now();
  let port = 0;
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const gate = allowed(req.headers, token, port);
    if (!gate.ok) return send(gate.status, { ok: false, error: gate.why });
    if (req.method !== "POST" || req.url !== "/rpc") return send(404, { ok: false, error: "not found" });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(d);
    });
    req.on("end", async () => {
      lastUsed = Date.now();
      let msg: { method?: unknown; params?: unknown };
      try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { ok: false, error: "bad request" }); }
      const handler = typeof msg.method === "string" ? o.handlers[msg.method as BridgeMethod] : undefined;
      if (!handler) return send(404, { ok: false, error: `unknown method ${String(msg.method).slice(0, 40)}` });
      try {
        const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
        send(200, { ok: true, result: (await handler(params)) ?? null });
      } catch (e) {
        send(200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  const file = join(o.userData, BRIDGE_FILE);
  const info: BridgeFile = { port, pid: process.pid, version: o.version, startedAt: Date.now() };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(info));
  await rename(`${file}.tmp`, file);
  const ours = () => { try { return existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as BridgeFile).pid === process.pid; } catch { return false; } };
  return {
    port,
    lastUsed: () => lastUsed,
    forget: () => { server.close(); if (ours()) rmSync(file, { force: true }); },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      // only our own bridge file goes (a second copy may have written its own meanwhile)
      if (ours()) await rm(file, { force: true });
    },
  };
}
