// OWNED BY: ux. The keyboard shortcuts sheet: opened from the rail, from Settings and with "?".
import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "../../ui";
import { t } from "@shared/i18n";
import { keyLabel, opensSheet, shortcutGroups } from "./shortcuts-core";
import { useShell } from "./store";

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

export function Keys({ keys }: { keys: string[] }) {
  return <span className="sc-keys">{keys.map((k) => <kbd key={k}>{keyLabel(k, isMac)}</kbd>)}</span>;
}

/** Listens for "?" anywhere in the window. Renders the sheet when open. */
export function ShortcutsSheet() {
  const open = useShell((s) => s.shortcutsOpen);
  const set = useShell((s) => s.set);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (opensSheet(e, e.target as HTMLElement | null) && !document.querySelector(".modal-scrim:not(.sc-scrim)")) { e.preventDefault(); set({ shortcutsOpen: true }); }
      else if (e.key === "Escape" && useShell.getState().shortcutsOpen) { e.stopPropagation(); set({ shortcutsOpen: false }); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [set]);
  if (!open) return null;
  const close = () => set({ shortcutsOpen: false });
  return (
    <div className="modal-scrim sc-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal sc-sheet" role="dialog" aria-label={t("sc.title")} aria-modal="true" tabIndex={-1} ref={(el) => el?.focus()}>
        <div className="row">
          <h2 className="modal-title">{t("sc.title")}</h2>
          <Button variant="ghost" size="icon" onClick={close} aria-label={t("shell.close")}><X /></Button>
        </div>
        <div className="sc-groups">
          {shortcutGroups().map((g) => (
            <section key={g.title} className="sc-group">
              <h3 className="sc-title">{g.title}</h3>
              {g.note && <p className="note">{g.note}</p>}
              <dl className="sc-list">
                {g.items.map((s) => (
                  <div key={s.keys.join("+") + s.does} className="sc-row"><dt>{s.does}</dt><dd><Keys keys={s.keys} /></dd></div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
