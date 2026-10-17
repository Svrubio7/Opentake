// What the stage says when there is nothing to show yet: one sentence and one clear action (choose a
// screen, wait for the camera, fix it), in place of a dark frame with small text on it.
import { useEffect, useRef } from "react";
import { Monitor, Video, VideoOff } from "lucide-react";
import { t } from "@shared/i18n";
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
        <b>{t("record.picker.title")}</b>
        <p>{mode === "screen-camera" ? t("record.empty.screenCamera") : t("record.empty.screen")}</p>
        <div className="rec-empty-actions">
          <Button variant="ink" size="lg" onClick={pickScreen}>{t("record.bar.chooseSource")}</Button>
          <Button variant="ghost" onClick={() => switchScene("camera")}><Video />{t("record.empty.cameraOnly")}</Button>
        </div>
      </div>
    );
  }

  if (mode === "camera" && cam !== "live") {
    const starting = cam === "starting" || cam === "idle";
    const text = starting ? t("record.empty.opening") : cam === "busy" ? t("record.empty.busy")
      : cam === "denied" ? t("record.empty.denied") : cam === "nocamera" ? t("record.empty.noCamera") : cam === "off" ? t("record.empty.off") : t("record.empty.failed");
    return (
      <div className="rec-empty">
        <span className={starting ? "rec-empty-mark busy" : "rec-empty-mark"}>{starting ? <Video /> : <VideoOff />}</span>
        <b>{starting ? t("record.empty.starting") : t("record.empty.noPicture")}</b>
        <p>{text}</p>
        {!starting && (
          <div className="rec-empty-actions">
            {cam === "denied" || cam === "off" ? <Button variant="ink" onClick={() => goTo("camera")}>{t("record.ready.openCamera")}</Button> : <Button variant="ink" onClick={retryCamera}>{t("record.ready.tryAgain")}</Button>}
            <Button variant="ghost" onClick={() => switchScene("screen")}><Monitor />{t("record.empty.recordScreen")}</Button>
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
    <span className={live ? "rec-level" : "rec-level off"} title={live ? t("record.dock.micLevel") : t("record.dock.micOff")} aria-hidden>
      <span className="rec-level-track"><span ref={bar} /></span>
    </span>
  );
}
