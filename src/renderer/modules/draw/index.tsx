// OWNED BY: shell agent. Drawing on the screen, from the main window: the Record panel's card,
// and the bridge that tells main which display the take records.
import { useEffect, useState } from "react";
import { PenLine } from "lucide-react";
import { IPC } from "@shared/ipc";
import type { DrawStatus } from "@shared/types";
import { Button, Card, Switch } from "../../ui";
import { useRecord } from "../record/store";

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
  const keys = s.shortcut.split("+");
  return (
    <Card title="Draw on screen" hint="Draw over anything on your screen while you record. The drawing is in the recording, the toolbar is not.">
      <div className="row">
        {s.shortcutOk
          ? <span className="note" title="Starts and stops drawing, from any app">{keys.map((k, i) => <span key={k}>{i > 0 && " "}<kbd>{k}</kbd></span>)}</span>
          : <span className="note note-warn">{s.shortcut} is taken by another app</span>}
        <Button variant={s.active ? "ink" : "outline"} size="sm" onClick={() => void bridge()?.invoke(IPC.drawToggle, !s.active)}>
          <PenLine />{s.active ? "Stop drawing" : "Draw"}
        </Button>
      </div>
      <Switch label="Fade strokes after 3 s" hint="Off: strokes stay until you clear them (C) or undo them" checked={s.fade}
        onChange={(fade) => void bridge()?.invoke(IPC.drawPrefs, { fade })} />
    </Card>
  );
}
