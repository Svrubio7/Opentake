// OWNED BY: shell agent. Updates in the main window: the calm notice when a new version is ready,
// the rail's About button (version, check for updates, release notes), and the busy signal that
// keeps a restart from ending a take or an export.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Info, RefreshCw } from "lucide-react";
import { IPC } from "@shared/ipc";
import type { UpdateStatus } from "@shared/types";
import { t } from "@shared/i18n";
import { Button } from "../../ui";
import { useRecord } from "../record/store";
import "./update.css";

const bridge = () => (typeof window !== "undefined" ? window.take : undefined);
const REPO_URL = "https://github.com/Svrubio7/Opentake";
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

function useUpdateStatus() {
  const [s, setS] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void b.invoke(IPC.updateStatus).then((v) => setS(v as UpdateStatus));
    return b.on(IPC.updateStatus, (v) => setS(v as UpdateStatus));
  }, []);
  return s;
}

const openRelease = () => void bridge()?.invoke(IPC.updateOpenRelease);
/** a newer version this copy can act on: downloaded (install) or found (notify, or a failed download) */
const hasNews = (s: UpdateStatus | null) => !!s?.version && (s.phase === "ready" || s.phase === "available");

/** Reports whether a take is recording or an export is running. Renders nothing. */
function BusySignal() {
  const busy = useRecord((s) => s.status !== "idle" || Object.values(s.exports).some((e) => !e.done && !e.error));
  useEffect(() => { bridge()?.send(IPC.updateBusy, busy); }, [busy]);
  return null;
}

/** The small card in the corner when a new version is ready or out. */
export function UpdateNotice() {
  const s = useUpdateStatus();
  const [later, setLater] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const show = s && hasNews(s) && later !== s.version;
  const ready = s?.phase === "ready" && s.mode === "install";
  return (
    <>
      <BusySignal />
      {show && (
        <div className="upd-notice" role="status">
          <p className="upd-title">{ready ? t("update.ready", { version: s.version ?? "" }) : t("update.out", { version: s.version ?? "" })}</p>
          <p className="note">
            {ready ? (s.busy || refused ? t("update.restartLater") : t("update.restartNow"))
              : s.mode === "install" ? t("update.downloadFailed")
                : isMac ? t("update.macManual") : t("update.manual")}
          </p>
          <div className="upd-actions">
            {ready ? (
              <Button variant="ink" size="sm" disabled={s.busy || s.fake} title={s.fake ? t("update.devNever") : s.busy ? t("update.waitsBusy") : undefined}
                onClick={async () => setRefused(!(await bridge()?.invoke(IPC.updateInstall)))}>{t("update.restart")}</Button>
            ) : (
              <Button variant="ink" size="sm" onClick={openRelease}>{t("update.download")}</Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setLater(s.version ?? null)}>{t("update.later")}</Button>
            <Button variant="link" className="upd-notes" onClick={openRelease}>{t("update.whatsNew")}<ExternalLink /></Button>
          </div>
        </div>
      )}
    </>
  );
}

function statusLine(s: UpdateStatus): string {
  if (s.mode === "off") return t("update.offLine");
  const version = s.version ?? "";
  switch (s.phase) {
    case "checking": return t("update.checking");
    case "none": return t("update.latest");
    case "downloading": {
      const v = s.version ?? t("update.theUpdate");
      return s.percent ? t("update.downloadingPct", { version: v, percent: s.percent }) : t("update.downloading", { version: v });
    }
    case "ready": return t("update.readyLine", { version });
    case "available": return t("update.availableLine", { version });
    case "error": return s.error ?? t("update.checkFailed");
    default: return s.mode === "install" ? t("update.autoInstall") : t("update.notifyOnly");
  }
}

/** The rail's About entry: version, update check, release notes. */
export function AboutButton() {
  const s = useUpdateStatus();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  if (!s) return null;
  const check = async () => {
    setChecking(true);
    try { await bridge()?.invoke(IPC.updateCheck); } finally { setChecking(false); }
  };
  const news = hasNews(s);
  return (
    <>
      <button ref={btn} type="button" className={open ? "rail-item on" : "rail-item"} onClick={() => setOpen((o) => !o)} title={`OpenTake ${s.current}`}
        aria-expanded={open}>
        <Info className="rail-icon" />
        <span className="rail-label">{t("update.about")} <span className="upd-rail-version tnum">{s.current}</span></span>
        {news && <i className="rail-dot" aria-label={t("update.available")} />}
      </button>
      {open && createPortal(
        <div ref={pop} className="upd-pop" role="dialog" aria-label={t("update.aboutAria")}>
          <p className="upd-title">OpenTake <span className="tnum">{s.current}</span></p>
          <p className="note">{t("update.byline")}</p>
          <p className={s.phase === "error" ? "note note-warn upd-line" : "note upd-line"} aria-live="polite">{statusLine(s)}</p>
          <div className="upd-actions">
            {s.phase === "ready" && s.mode === "install" ? (
              <Button variant="ink" size="sm" disabled={s.busy || s.fake} onClick={() => void bridge()?.invoke(IPC.updateInstall)}>{t("update.restartToUpdate")}</Button>
            ) : news ? (
              <Button variant="ink" size="sm" onClick={openRelease}>{t("update.download")}</Button>
            ) : (
              <Button size="sm" disabled={s.mode === "off" || checking || s.phase === "downloading"} onClick={() => void check()}>
                <RefreshCw className={checking ? "upd-spin" : undefined} />{t("update.check")}
              </Button>
            )}
            <Button variant="link" className="upd-notes" onClick={openRelease}>{t("update.notes")}<ExternalLink /></Button>
          </div>
          <a className="upd-repo" href={REPO_URL} target="_blank" rel="noreferrer">{t("update.source")}</a>
        </div>,
        document.body,
      )}
    </>
  );
}
