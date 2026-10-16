// OWNED BY: audio agent. The sidebar panel for the mic. The engine starts on first mount and keeps
// running while the panel is hidden, publishing the processed voice as the "mic" stream.
import { useEffect } from "react";
import { Controls, Presets } from "./Controls";
import { Meters } from "./Meters";
import { MicCheck } from "./MicCheck";
import { getEngine } from "./engine";
import { retry, selectDevice, setMonitor } from "./actions";
import { useAudioStore } from "./store";
import "./audio.css";

const STATUS: Record<string, string> = { idle: "Off", starting: "Starting", running: "Live", error: "No mic" };

export function AudioPanel() {
  const status = useAudioStore((s) => s.status);
  const error = useAudioStore((s) => s.error);
  const devices = useAudioStore((s) => s.devices);
  const deviceId = useAudioStore((s) => s.deviceId);
  const monitor = useAudioStore((s) => s.monitor);

  useEffect(() => { void getEngine().start(); }, []);

  // Show the device actually open; "default" when nothing specific was picked.
  const selected = deviceId && devices.some((d) => d.id === deviceId) ? deviceId : "";

  return (
    <div className="au">
      <div className="au-top">
        <h2>Microphone</h2>
        <span className={`au-status ${status}`}><i />{STATUS[status]}</span>
      </div>

      <select className="au-device" value={selected} onChange={(e) => selectDevice(e.target.value || null)} aria-label="Microphone">
        <option value="">System default</option>
        {devices.filter((d) => d.id !== "default" && d.id !== "communications").map((d) => (
          <option key={d.id} value={d.id}>{d.label}</option>
        ))}
      </select>

      {error && (
        <div className="au-error">
          <p>{error}</p>
          <button onClick={retry}>Try again</button>
        </div>
      )}

      <Meters />
      <MicCheck />

      <div className="au-row">
        <span className="au-label">Sound</span>
        <label className="au-listen">
          <input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />
          Listen (headphones)
        </label>
      </div>
      <Presets />
      <Controls />
    </div>
  );
}
