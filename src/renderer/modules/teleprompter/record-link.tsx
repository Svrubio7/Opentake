// The prompter's link to the recorder: it opens by itself when a take starts, and the record bar
// has a button for it, so nobody has to find the Teleprompter tab before reading.
import { ScrollText } from "lucide-react";
import { Button } from "../../ui";
import { useRecord } from "../record/store";
import { hidePrompter, parsedFor, prompterShown, showPrompter, usePrompter } from "./store";

const hasScript = () => parsedFor(usePrompter.getState().state).words.length > 0;

/** Asks the app to switch the side panel to a tab (App.tsx listens). */
export const openTab = (id: string) => window.dispatchEvent(new CustomEvent("opentake:tab", { detail: id }));

let linked = false;
/** When a take starts (countdown or straight to recording), show the prompter if there is a script. */
export function linkPrompterToRecorder() {
  if (linked) return;
  linked = true;
  useRecord.subscribe((s, prev) => {
    if (prev.status !== "idle" || s.status === "idle") return;
    const p = usePrompter.getState();
    if (p.settings.showOnRecord && hasScript() && !prompterShown(p)) showPrompter();
  });
}

/** The record bar's prompter button: show or hide it, or go write a script first. */
export function PrompterToggle() {
  const shown = usePrompter(prompterShown);
  const words = usePrompter((x) => parsedFor(x.state).words.length);
  const title = !words ? "Write a script in the Teleprompter tab" : shown ? "Hide the teleprompter" : "Show the teleprompter";
  return (
    <Button size="icon" variant={shown ? "outline" : "ghost"} className={shown ? "rec-tp on" : "rec-tp"} title={title} aria-label={title} aria-pressed={shown}
      onClick={() => (!words ? openTab("prompter") : shown ? hidePrompter() : showPrompter())}>
      <ScrollText />
    </Button>
  );
}
