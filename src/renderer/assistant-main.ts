// The hidden window the app opens to make captions for the assistant (the MCP server): the editor's own
// recognizer (Vosk, on this computer) and line grouping, with no UI. src/main/mcp/transcriber.ts drives it.
import { IPC } from "@shared/ipc";
import type { CaptionLang } from "@shared/types";
import { fromVosk, groupWords } from "./modules/editor/captions-core";
import { transcribe } from "./modules/editor/transcribe";

interface Job { jobId: string; takeId: string; lang: CaptionLang }

const t = window.take;

t.on(IPC.assistantWorkerJob, async (raw) => {
  const job = raw as Job;
  try {
    const words = await transcribe(job.takeId, job.lang, (stage, ratio) => t.send(IPC.assistantWorkerProgress, { jobId: job.jobId, stage, ratio }));
    const lines = groupWords(fromVosk(words, job.lang), job.lang);
    await t.invoke(IPC.assistantWorkerDone, { jobId: job.jobId, lines });
  } catch (e) {
    await t.invoke(IPC.assistantWorkerDone, { jobId: job.jobId, error: e instanceof Error ? e.message : String(e) });
  }
});

t.send(IPC.assistantWorkerReady);
