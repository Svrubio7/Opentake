// OWNED BY: shell agent. The updater's decisions, kept free of Electron so they can be tested.
import type { UpdateMode } from "../shared/types";
import { t } from "../shared/i18n";

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_REPO = { owner: "Svrubio7", repo: "Opentake" };

export interface UpdateEnv {
  platform: NodeJS.Platform;
  packaged: boolean;
  /** set by electron-builder's portable launcher */
  portableDir?: string;
  /** set by the AppImage runtime */
  appImage?: string;
  /** the mac build was signed and notarized (Squirrel.Mac refuses anything else) */
  macSigned: boolean;
  /** dev only: pretend to be this version so the real releases look new */
  fakeVersion?: string;
}

/**
 * What this copy of the app can do with a new version.
 * install: download in the background and replace itself on restart (Windows installer, AppImage, signed mac).
 * notify: say a new version exists and link to it (portable exe, unsigned mac, Linux outside an AppImage).
 * off: a dev build with nothing to compare against.
 */
export function updateMode(env: UpdateEnv): UpdateMode {
  if (!env.packaged && !env.fakeVersion) return "off";
  if (env.platform === "win32") return env.portableDir ? "notify" : "install";
  if (env.platform === "darwin") return env.macSigned ? "install" : "notify";
  if (env.platform === "linux") return env.appImage ? "install" : "notify";
  return "notify";
}

/** owner/repo from package.json "repository", the same place electron-builder reads it. */
export function repoFrom(repository: unknown): { owner: string; repo: string } | null {
  const url = typeof repository === "string" ? repository
    : repository && typeof repository === "object" && typeof (repository as { url?: unknown }).url === "string" ? (repository as { url: string }).url : "";
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?\/?$/i.exec(url) ?? /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** The release page for a version (electron-builder tags releases "v" + version). */
export function releaseUrl(r: { owner: string; repo: string }, version?: string) {
  const base = `https://github.com/${r.owner}/${r.repo}/releases`;
  return version ? `${base}/tag/v${version.replace(/^v/, "")}` : `${base}/latest`;
}

/** A valid x.y.z(-pre) version, or null. Only used to accept the dev override. */
export function cleanVersion(v: string | undefined): string | null {
  const s = (v ?? "").trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(s) ? s : null;
}

/** Restarting into the new version would end a take or an export: wait until both are done. */
export function canRestart(s: { ready: boolean; busy: boolean; mode: UpdateMode; fake: boolean }) {
  return s.ready && !s.busy && s.mode === "install" && !s.fake;
}

/** A plain sentence for an updater error (network errors are the common case and say so). */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(msg)) return t("main.update.noNetwork");
  if (/404|No published versions|Cannot find latest/i.test(msg)) return t("main.update.noRelease");
  if (/rate limit|403/i.test(msg)) return t("main.update.busy");
  return t("main.update.failed");
}
