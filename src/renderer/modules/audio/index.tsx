// OWNED BY: audio agent. The sidebar panel for the mic. The engine starts on first mount and keeps
// running while the panel is hidden, publishing the processed voice as the "mic" stream.
import { useEffect } from "react";
import { Controls, Presets } from "./Controls";
import { Meters } from "./Meters";
import { MicCheck } from "./MicCheck";
import { getEngine } from "./engine";
import { retry, selectDevice, setMonitor } from "./actions";
import { useAudioStore } from "./store";
import { Button, Card, Switch, Tag } from "../../ui";
import { t } from "@shared/i18n";
import "./audio.css";

const STATUS = { idle: "audio.status.idle", starting: "audio.status.starting", running: "audio.status.running", error: "audio.status.error" } as const;

const TONE: Record<string, "neutral" | "warn" | "good" | "danger"> = { idle: "neutral", starting: "warn", running: "good", error: "danger" };

export function AudioPanel() {
  const status = useAudioStore((s) => s.status);
  const error = useAudioStore((s) => s.error);
  const devices = useAudioStore((s) => s.devices);
  const deviceId = useAudioStore((s) => s.deviceId);
  const monitor = useAudioStore((s) => s.monitor);
  const monitorNotice = useAudioStore((s) => s.monitorNotice);

  useEffect(() => { void getEngine().start(); }, []);

  // Show the device actually open; "default" when nothing specific was picked.
  const selected = deviceId && devices.some((d) => d.id === deviceId) ? deviceId : "";

  return (
    <div className="cards au">
      <Card title={t("card.input")} action={<Tag tone={TONE[status] ?? "neutral"}>{t(STATUS[status])}</Tag>}>
        <select className="select" value={selected} onChange={(e) => selectDevice(e.target.value || null)} aria-label={t("audio.microphone")}>
          <option value="">{t("audio.systemDefault")}</option>
          {devices.filter((d) => d.id !== "default" && d.id !== "communications").map((d) => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
        </select>
        {error && (
          <div className="au-error">
            <p>{error}</p>
            <Button size="sm" onClick={retry}>{t("audio.tryAgain")}</Button>
          </div>
        )}
        <Switch label={t("audio.listen")} hint={t("audio.listenHint")} checked={monitor} onChange={(v) => setMonitor(v)} />
        {monitorNotice && <p className="note note-warn">{monitorNotice}</p>}
      </Card>

      <Meters />
      <MicCheck />

      <Card title={t("card.sound")} hint={t("audio.soundHint")}>
        <Presets />
        <Controls />
      </Card>
    </div>
  );
}
