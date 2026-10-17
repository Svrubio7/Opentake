// The prompter inside the main window: a box the person drags, resizes and snaps anywhere.
// It is plain DOM over the app; the recorder's compositor draws only media streams, so it never
// lands in a recording (unless the screen being recorded shows OpenTake itself: use Pop out then).
import { useEffect, useRef, useState } from "react";
import { ExternalLink, GripHorizontal, X } from "lucide-react";
import { reportPosition } from "./controller";
import { clampRect, moveRect, resizeRect, snapRect, toPixels, type Corner, type Rect, type Snap } from "./overlay-core";
import { keyCommand } from "./prompter-core";
import { PrompterSurface } from "./PrompterView";
import { hidePrompter, showPrompter, usePrompter } from "./store";

const SNAPS: { id: Snap; label: string; title: string }[] = [
  { id: "top", label: "Top", title: "Top centre, under the webcam" },
  { id: "center", label: "Centre", title: "Centre of the window" },
  { id: "left", label: "Left", title: "Left side" },
  { id: "right", label: "Right", title: "Right side" },
];
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

function useViewport() {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return vp;
}

export function PrompterOverlay() {
  const open = usePrompter((s) => s.overlayOpen);
  return open ? <OverlayBox /> : null;
}

function OverlayBox() {
  const state = usePrompter((s) => s.state);
  const saved = usePrompter((s) => s.settings.overlay);
  const opacity = usePrompter((s) => s.settings.window.opacity);
  const setSettings = usePrompter((s) => s.setSettings);
  const command = usePrompter((s) => s.command);
  const vp = useViewport();
  const [draft, setDraft] = useState<Rect | null>(null);
  const draftRef = useRef<Rect | null>(null);
  const drag = useRef<{ kind: "move" | Corner; x: number; y: number; start: Rect } | null>(null);

  const rect = clampRect(draft ?? saved, vp);
  const px = toPixels(rect, vp);

  const begin = (kind: "move" | Corner) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, start: rect };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    const next = d.kind === "move" ? moveRect(d.start, dx, dy, vp) : resizeRect(d.start, d.kind, dx, dy, vp);
    draftRef.current = next;
    setDraft(next);
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    // saved once per gesture, not on every pointer move
    if (draftRef.current) setSettings({ overlay: draftRef.current });
    draftRef.current = null;
    setDraft(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cmd = keyCommand(e.nativeEvent);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation(); // the panel's own key handler would run it a second time
    command(cmd);
  };

  return (
    <div className={`tpo${draft ? " tpo-dragging" : ""}`} style={{ ...px, opacity }} tabIndex={-1} onKeyDown={onKeyDown}
      onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} data-teleprompter-overlay="">
      <PrompterSurface state={state} embedded onPosition={reportPosition} onClose={hidePrompter} />
      <div className="tpo-bar" onPointerDown={begin("move")} title="Drag to move">
        <span className="tpo-title"><GripHorizontal />Prompter</span>
        <div className="tpo-actions">
          {SNAPS.map((s) => (
            <button key={s.id} type="button" title={s.title} onClick={() => setSettings({ overlay: snapRect(s.id, vp) })}>{s.label}</button>
          ))}
          <button type="button" title="Open in its own window, always on top" aria-label="Pop out" onClick={() => showPrompter("window")}><ExternalLink /></button>
          <button type="button" className="tpo-close" title="Hide the prompter" aria-label="Hide the prompter" onClick={hidePrompter}><X /></button>
        </div>
      </div>
      {CORNERS.map((c) => <div key={c} className={`tpo-grip tpo-${c}`} onPointerDown={begin(c)} />)}
    </div>
  );
}
