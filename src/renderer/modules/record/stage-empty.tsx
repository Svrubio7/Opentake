// What the stage says when there is nothing to show yet: one sentence and one clear action (choose a
// screen, wait for the camera, fix it), in place of a dark frame with small text on it.
import { useEffect, useRef } from "react";
import { Monitor, Video, VideoOff } from "lucide-react";
import { Button } from "../../ui";
import { getEngine } from "../audio/engine";
import { useAudioStore } from "../audio/store";
import { retryCamera } from "../camera/engine";
import { useCamera } from "../camera/store";
import { goTo } from "../shell/store";
import { needsScreen } from "./layout-core";
import { pickScreen } from "./readiness";
import { switchScene } from "./recorder";
import { useRecord } from "./store";

export function StageEmpty() {
  const mode = useRecord((s) => s.mode);
  const sourceId = useRecord((s) => s.sourceId);
  const status = useRecord((s) => s.status);
  const cam = useCamera((s) => s.status);
  if (status !== "idle") return null;

  if (needsScreen(mode) && !sourceId) {
    return (
      <div className="rec-empty">
        <span className="rec-empty-mark"><Monitor /></span>
        <b>Choose what to record</b>
        <p>{mode === "screen-camera" ? "A whole screen or one window, with your camera in the corner." : "A whole screen or one window."}</p>
        <div className="rec-empty-actions">
          <Button variant="ink" size="lg" onClick={pickScreen}>Choose a screen or window</Button>
          <Button variant="ghost" onClick={() => switchScene("camera")}><Video />Camera only</Button>
        </div>
      </div>
    );
  }

  if (mode === "camera" && cam !== "live") {
    const starting = cam === "starting" || cam === "idle";
    const text = starting ? "Opening your camera." : cam === "busy" ? "Another app is using the camera. Close it, then try again."
      : cam === "denied" ? "The camera is blocked for OpenTake in your system's privacy settings." : cam === "nocamera" ? "No camera is connected." : cam === "off" ? "The camera is switched off." : "The camera stopped working.";
    return (
      <div className="rec-empty">
        <span className={starting ? "rec-empty-mark busy" : "rec-empty-mark"}>{starting ? <Video /> : <VideoOff />}</span>
        <b>{starting ? "Starting the camera" : "No camera picture"}</b>
        <p>{text}</p>
        {!starting && (
          <div className="rec-empty-actions">
            {cam === "denied" || cam === "off" ? <Button variant="ink" onClick={() => goTo("camera")}>Open Camera</Button> : <Button variant="ink" onClick={retryCamera}>Try again</Button>}
            <Button variant="ghost" onClick={() => switchScene("screen")}><Monitor />Record the screen</Button>
          </div>
        )}
      </div>
    );
  }
  return null;
}

/** The mic's level in the dock: the mic input, drawn straight from the engine. */
export function DockLevel() {
  const bar = useRef<HTMLSpanElement>(null);
  const live = useAudioStore((s) => s.status === "running");
  useEffect(() => getEngine().onInput((m) => {
    const v = Math.max(0, Math.min(1, (m.rmsDb + 60) / 60));
    if (bar.current) bar.current.style.transform = `scaleX(${v})`;
  }), []);
  return (
    <span className={live ? "rec-level" : "rec-level off"} title={live ? "Mic level" : "The mic is not on"} aria-hidden>
      <span className="rec-level-track"><span ref={bar} /></span>
    </span>
  );
}
