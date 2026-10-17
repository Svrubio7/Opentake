// OWNED BY: shell agent. Drawing on the screen, from the main window: the Record panel's card,
// and the bridge that tells main which display the take records.
import { useEffect, useState } from "react";
import { PenLine } from "lucide-react";
import { IPC } from "@shared/ipc";
import type { DrawStatus } from "@shared/types";
import { Button, Card, Switch } from "../../ui";
import { useRecord } from "../record/store";
import { t } from "@shared/i18n";
import { keyLabel } from "../shell/shortcuts-core";

const bridge = () => (typeof window !== "undefined" ? window.take : undefined);

function useDrawStatus() {
  const [s, setS] = useState<DrawStatus | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void b.invoke(IPC.drawStatus).then((v) => setS(v as DrawStatus));
    return b.on(IPC.drawStatus, (v) => setS(v as DrawStatus));
  }, []);
  return s;
}

/** Keeps main told which display is being recorded, so the drawing lands on it. Renders nothing. */
export function DrawBridge() {
  const displayId = useRecord((s) => s.displayId);
  useEffect(() => { bridge()?.send(IPC.drawDisplay, displayId ?? ""); }, [displayId]);
  return null;
}

export function DrawCard() {
  const s = useDrawStatus();
  if (!s) return null;
  // main sends the accelerator as typed (Ctrl+Shift+D): each key reads as the keyboard prints it here
  const keys = s.shortcut.split("+").map((k) => keyLabel(k, false));
  return (
    <Card title={t("card.drawOnScreen")} hint={t("draw.cardHint")}>
      <div className="row">
        {s.shortcutOk
          ? <span className="note" title={t("draw.shortcutHint")}>{keys.map((k, i) => <span key={k}>{i > 0 && " "}<kbd>{k}</kbd></span>)}</span>
          : <span className="note note-warn">{t("draw.shortcutTaken", { shortcut: keys.join("+") })}</span>}
        <Button variant={s.active ? "ink" : "outline"} size="sm" onClick={() => void bridge()?.invoke(IPC.drawToggle, !s.active)}>
          <PenLine />{s.active ? t("draw.stop") : t("draw.start")}
        </Button>
      </div>
      <Switch label={t("draw.fade")} hint={t("draw.fadeHint")} checked={s.fade}
        onChange={(fade) => void bridge()?.invoke(IPC.drawPrefs, { fade })} />
    </Card>
  );
}
