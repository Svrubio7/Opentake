import { useState } from "react";
import { AudioPanel } from "./modules/audio";
import { CameraPanel } from "./modules/camera";
import { RecordPanel, Stage } from "./modules/record";
import { PrompterOverlay, TeleprompterPanel } from "./modules/teleprompter";

const TABS = [
  { id: "record", label: "Record", Panel: RecordPanel },
  { id: "audio", label: "Mic", Panel: AudioPanel },
  { id: "camera", label: "Camera", Panel: CameraPanel },
  { id: "prompter", label: "Teleprompter", Panel: TeleprompterPanel },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App() {
  const [tab, setTab] = useState<TabId>("record");
  return (
    <div className="app">
      <main className="stage-wrap"><Stage /></main>
      <aside className="side">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? "tab on" : "tab"} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        {/* Every panel stays mounted so its engine keeps running while another tab is open. */}
        {TABS.map(({ id, Panel }) => (
          <section key={id} className="panel" hidden={id !== tab}><Panel /></section>
        ))}
      </aside>
      <PrompterOverlay />
    </div>
  );
}
