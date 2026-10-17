import { useEffect, useState, type ComponentType } from "react";
import { CircleDot, Film, Keyboard, Mic, ScrollText, Settings, Video, type LucideIcon } from "lucide-react";
import markWhite from "./assets/iconwhitenobg.png";
import { AudioPanel } from "./modules/audio";
import { CameraPanel } from "./modules/camera";
import { RecordBar, RecordPanel, RecordRailStatus, Stage, TakesPanel } from "./modules/record";
import { useRecord } from "./modules/record/store";
import { refreshTakes } from "./modules/record/recorder";
import { PrompterOverlay, TeleprompterPanel, linkPrompterToRecorder } from "./modules/teleprompter";
import { DrawBridge } from "./modules/draw";
import { AboutButton, UpdateNotice } from "./modules/update";
import { SettingsPanel, ShellHost, refreshSettings, useShell } from "./modules/shell";

interface Tab { id: string; label: string; title: string; icon: LucideIcon; Panel: ComponentType; hint: string; foot?: boolean }

const TABS: Tab[] = [
  { id: "record", label: "Record", title: "Record", icon: CircleDot, Panel: RecordPanel, hint: "Set up and record a take" },
  { id: "takes", label: "Takes", title: "Takes", icon: Film, Panel: TakesPanel, hint: "Your recordings: edit, export, rename" },
  { id: "audio", label: "Mic", title: "Microphone", icon: Mic, Panel: AudioPanel, hint: "Microphone and voice cleanup" },
  { id: "camera", label: "Camera", title: "Camera", icon: Video, Panel: CameraPanel, hint: "Camera, lighting and background" },
  { id: "prompter", label: "Teleprompter", title: "Teleprompter", icon: ScrollText, Panel: TeleprompterPanel, hint: "A script that scrolls as you read" },
  { id: "settings", label: "Settings", title: "Settings", icon: Settings, Panel: SettingsPanel, hint: "Folders, export names and help", foot: true },
];

function RailItem({ tab, on, onClick, dot }: { tab: Tab; on: boolean; onClick: () => void; dot?: boolean }) {
  const Icon = tab.icon;
  return (
    <button type="button" className={on ? "rail-item on" : "rail-item"} onClick={onClick} title={`${tab.label}: ${tab.hint}`} aria-current={on ? "page" : undefined}>
      <Icon className="rail-icon" />
      <span className="rail-label">{tab.label}</span>
      {on && <i className="rail-dot" aria-hidden />}
      {!on && dot && <i className="rail-dot new" aria-label="New take" />}
    </button>
  );
}

export function App() {
  const [tab, setTab] = useState("record");
  const setShell = useShell((s) => s.set);
  // a dot on Takes when a take arrived since you last looked
  const newest = useRecord((s) => s.takes[0]?.createdAt ?? 0);
  const [seen, setSeen] = useState(() => Date.now());
  useEffect(() => { if (tab === "takes") setSeen(Math.max(Date.now(), newest)); }, [tab, newest]);

  useEffect(() => {
    linkPrompterToRecorder();
    // other modules ask for a tab (the record bar sends you to write a script, a notice to your takes)
    const onTab = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (TABS.some((t) => t.id === id)) setTab(id); };
    window.addEventListener("opentake:tab", onTab);
    return () => window.removeEventListener("opentake:tab", onTab);
  }, []);
  // folders can change outside the app (a drive unplugged): look again when a tab that shows them opens
  useEffect(() => {
    if (tab === "takes" || tab === "settings" || tab === "record") void refreshSettings();
    // takes may have been renamed, moved or deleted in Explorer or Finder meanwhile
    if (tab === "takes") void refreshTakes();
  }, [tab]);

  return (
    <div className="app">
      <nav className="rail" aria-label="Sections">
        <div className="rail-brand">
          <img src={markWhite} alt="" className="rail-mark" />
          <span className="rail-label rail-brand-text"><b>OpenTake</b><small>by Quetzal</small></span>
        </div>
        {TABS.filter((t) => !t.foot).map((t) => (
          <RailItem key={t.id} tab={t} on={t.id === tab} onClick={() => setTab(t.id)} dot={t.id === "takes" && newest > seen} />
        ))}
        <div className="rail-foot">
          <RecordRailStatus onOpen={() => setTab("record")} />
          <button type="button" className="rail-item" onClick={() => setShell({ shortcutsOpen: true })} title="Keyboard shortcuts (?)">
            <Keyboard className="rail-icon" />
            <span className="rail-label">Shortcuts</span>
          </button>
          {TABS.filter((t) => t.foot).map((t) => <RailItem key={t.id} tab={t} on={t.id === tab} onClick={() => setTab(t.id)} />)}
          <AboutButton />
        </div>
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
      <ShellHost />
    </div>
  );
}
