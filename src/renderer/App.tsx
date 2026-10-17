import { useState, type ComponentType } from "react";
import { CircleDot, Mic, ScrollText, Video, type LucideIcon } from "lucide-react";
import markWhite from "./assets/iconwhitenobg.png";
import { AudioPanel } from "./modules/audio";
import { CameraPanel } from "./modules/camera";
import { RecordBar, RecordPanel, RecordRailStatus, Stage } from "./modules/record";
import { PrompterOverlay, TeleprompterPanel } from "./modules/teleprompter";
import { DrawBridge } from "./modules/draw";
import { AboutButton, UpdateNotice } from "./modules/update";

const TABS: { id: string; label: string; title: string; icon: LucideIcon; Panel: ComponentType }[] = [
  { id: "record", label: "Record", title: "Record", icon: CircleDot, Panel: RecordPanel },
  { id: "audio", label: "Mic", title: "Microphone", icon: Mic, Panel: AudioPanel },
  { id: "camera", label: "Camera", title: "Camera", icon: Video, Panel: CameraPanel },
  { id: "prompter", label: "Teleprompter", title: "Teleprompter", icon: ScrollText, Panel: TeleprompterPanel },
];

export function App() {
  const [tab, setTab] = useState("record");
  return (
    <div className="app">
      <nav className="rail" aria-label="Sections">
        <div className="rail-brand">
          <img src={markWhite} alt="" className="rail-mark" />
          <span className="rail-label rail-brand-text"><b>OpenTake</b><small>by Quetzal</small></span>
        </div>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={id === tab ? "rail-item on" : "rail-item"} onClick={() => setTab(id)}
            title={label} aria-current={id === tab ? "page" : undefined}>
            <Icon className="rail-icon" />
            <span className="rail-label">{label}</span>
            {id === tab && <i className="rail-dot" aria-hidden />}
          </button>
        ))}
        <div className="rail-foot"><RecordRailStatus onOpen={() => setTab("record")} /><AboutButton /></div>
      </nav>

      <main className="workspace">
        <div className="stage-card"><Stage /></div>
        <RecordBar />
      </main>

      <aside className="side">
        {/* Every panel stays mounted so its engine keeps running while another tab is open. */}
        {TABS.map(({ id, title, Panel }) => (
          <section key={id} className="panel" hidden={id !== tab} aria-label={title}>
            <h1 className="panel-title">{title}</h1>
            <Panel />
          </section>
        ))}
      </aside>
      <PrompterOverlay />
      <UpdateNotice />
      <DrawBridge />
    </div>
  );
}
