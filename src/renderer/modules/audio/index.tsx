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
import "./audio.css";

const STATUS: Record<string, string> = { idle: "Off", starting: "Starting", running: "Live", error: "No mic" };
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
      <Card title="Input" action={<Tag tone={TONE[status] ?? "neutral"}>{STATUS[status]}</Tag>}>
        <select className="select" value={selected} onChange={(e) => selectDevice(e.target.value || null)} aria-label="Microphone">
          <option value="">System default</option>
          {devices.filter((d) => d.id !== "default" && d.id !== "communications").map((d) => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
        </select>
        {error && (
          <div className="au-error">
            <p>{error}</p>
            <Button size="sm" onClick={retry}>Try again</Button>
          </div>
        )}
        <Switch label="Listen" hint="Hear the processed voice. Use headphones so the mic does not pick up the speakers. It turns itself off if the speakers start feeding back." checked={monitor} onChange={(v) => setMonitor(v)} />
        {monitorNotice && <p className="note note-warn">{monitorNotice}</p>}
      </Card>

      <Meters />
      <MicCheck />

      <Card title="Sound" hint="A preset sets every stage below. Open a stage to fine tune it.">
        <Presets />
        <Controls />
      </Card>
    </div>
  );
}
