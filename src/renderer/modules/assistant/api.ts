// The assistant's channels from the window: connecting Claude or Codex, the activity list, Undo, and
// "Open in an editor". When the assistant changes a take, the main process says so and this file passes
// it on as a window event the takes list and an open editor listen to.
import { IPC } from "@shared/ipc";
import type { AssistantStatus, SetupResult, TestResult } from "@shared/assistant";
import type { ActivityEntry, UndoResult } from "../../../main/mcp/activity";
import type { TimelineOptions, TimelineResult } from "../../../main/record/timeline-export";

const t = () => window.take;

export const assistantApi = {
  status: () => t().invoke(IPC.assistantStatus) as Promise<AssistantStatus>,
  setupClaude: () => t().invoke(IPC.assistantSetupClaude) as Promise<SetupResult>,
  test: () => t().invoke(IPC.assistantTest) as Promise<TestResult>,
  activity: () => t().invoke(IPC.assistantActivity) as Promise<ActivityEntry[]>,
  undo: (id: string) => t().invoke(IPC.assistantUndo, id) as Promise<UndoResult>,
  timeline: (takeId: string, o: TimelineOptions) => t().invoke(IPC.assistantTimeline, takeId, o) as Promise<TimelineResult>,
};

const EVENT = "opentake:take-changed";

/** Starts passing the main process's "the assistant changed a take" on to the window. Once, at startup. */
export function listenForAssistant(onAny: (takeId: string) => void): () => void {
  return t().on(IPC.assistantChanged, (p) => {
    const takeId = (p as { takeId?: string })?.takeId;
    if (!takeId) return;
    onAny(takeId);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: takeId }));
  });
}

/** Runs `fn` when the assistant changes this take (or any take, with null). */
export function onTakeChanged(takeId: string | null, fn: () => void): () => void {
  const h = (e: Event) => { if (takeId == null || (e as CustomEvent<string>).detail === takeId) fn(); };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
