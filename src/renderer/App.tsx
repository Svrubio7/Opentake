import { useEffect, useState, type ComponentType } from "react";
import { CircleDot, Film, Keyboard, Mic, ScrollText, Settings, Video, type LucideIcon } from "lucide-react";
import { t } from "@shared/i18n";
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
import { AssistantSync } from "./modules/assistant";

type TabId = "record" | "takes" | "audio" | "camera" | "prompter" | "settings";
interface Tab { id: TabId; icon: LucideIcon; Panel: ComponentType; foot?: boolean }

const TABS: Tab[] = [
  { id: "record", icon: CircleDot, Panel: RecordPanel },
  { id: "takes", icon: Film, Panel: TakesPanel },
  { id: "audio", icon: Mic, Panel: AudioPanel },
  { id: "camera", icon: Video, Panel: CameraPanel },
  { id: "prompter", icon: ScrollText, Panel: TeleprompterPanel },
  { id: "settings", icon: Settings, Panel: SettingsPanel, foot: true },
];
const label = (id: TabId) => t(`app.tab.${id}`);
const title = (id: TabId) => t(`app.tab.${id}.title`);
const hint = (id: TabId) => t(`app.tab.${id}.hint`);

function RailItem({ tab, on, onClick, dot }: { tab: Tab; on: boolean; onClick: () => void; dot?: boolean }) {
  const Icon = tab.icon;
  return (
    <button type="button" className={on ? "rail-item on" : "rail-item"} onClick={onClick} title={t("app.railHint", { label: label(tab.id), hint: hint(tab.id) })} aria-current={on ? "page" : undefined}>
      <Icon className="rail-icon" />
      <span className="rail-label">{label(tab.id)}</span>
      {on && <i className="rail-dot" aria-hidden />}
      {!on && dot && <i className="rail-dot new" aria-label={t("app.newTake")} />}
    </button>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>("record");
  const setShell = useShell((s) => s.set);
  // a dot on Takes when a take arrived since you last looked
  const newest = useRecord((s) => s.takes[0]?.createdAt ?? 0);
  const [seen, setSeen] = useState(() => Date.now());
  useEffect(() => { if (tab === "takes") setSeen(Math.max(Date.now(), newest)); }, [tab, newest]);

  useEffect(() => {
    linkPrompterToRecorder();
    // other modules ask for a tab (the record bar sends you to write a script, a notice to your takes)
    const onTab = (e: Event) => { const id = (e as CustomEvent<string>).detail; const known = TABS.find((x) => x.id === id); if (known) setTab(known.id); };
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
      <AssistantSync />
      <nav className="rail" aria-label={t("app.sections")}>
        <div className="rail-brand">
          <img src={markWhite} alt="" className="rail-mark" />
          <span className="rail-label rail-brand-text"><b>OpenTake</b><small>{t("app.byQuetzal")}</small></span>
        </div>
        {TABS.filter((t) => !t.foot).map((t) => (
          <RailItem key={t.id} tab={t} on={t.id === tab} onClick={() => setTab(t.id)} dot={t.id === "takes" && newest > seen} />
        ))}
        <div className="rail-foot">
          <RecordRailStatus onOpen={() => setTab("record")} />
          <button type="button" className="rail-item" onClick={() => setShell({ shortcutsOpen: true })} title={t("app.shortcutsHint")}>
            <Keyboard className="rail-icon" />
            <span className="rail-label">{t("app.shortcuts")}</span>
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
        {TABS.map(({ id, Panel }) => (
          <section key={id} className="panel" hidden={id !== tab} aria-label={title(id)}>
            <h1 className="panel-title">{title(id)}</h1>
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
