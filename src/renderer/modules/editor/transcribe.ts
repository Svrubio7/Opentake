// Captions from the take's own sound, on this computer: the main process decodes 16 kHz mono with
// ffmpeg, and Vosk (the teleprompter's speech models, running in their own worker) times every word.
import type { CaptionLang } from "@shared/types";
import { t } from "@shared/i18n";
import { loadModel } from "../teleprompter/voice";
import { editorApi } from "./api";

export interface VoskWord { word: string; start: number; end: number; conf: number }

const RATE = 16000;
/** half a second of sound per message to the worker */
const CHUNK = 8000;
/** messages in flight at once, so a long take does not queue its whole sound in the worker */
const IN_FLIGHT = 6;

export async function transcribe(takeId: string, lang: CaptionLang, onProgress: (stage: string, ratio: number | null) => void, signal?: AbortSignal): Promise<VoskWord[]> {
  onProgress(t("editor.captions.readingSound"), null);
  const pcm = await editorApi.pcm(takeId);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  onProgress(t("editor.captions.loadingModel"), null);
  const model = await loadModel(lang);
  if (signal?.aborted) throw new Error("Stopped");
  const rec = new model.KaldiRecognizer(RATE);
  rec.setWords(true);

  const words: VoskWord[] = [];
  const chunks = Math.ceil(samples.length / CHUNK);
  let answered = 0;
  let wake: (() => void) | null = null;
  let failure: string | null = null;
  let finalDone: (() => void) | null = null;
  rec.on("result", (m) => {
    if (m.event !== "result") return;
    words.push(...((m.result as { result?: VoskWord[] }).result ?? []));
    if (finalDone && answered >= chunks) { finalDone(); return; }
    answered++;
    wake?.();
  });
  rec.on("partialresult", () => { answered++; wake?.(); });
  rec.on("error", (m) => { if (m.event === "error") { failure = m.error; wake?.(); finalDone?.(); } });

  try {
    for (let i = 0; i < chunks; i++) {
      if (signal?.aborted) throw new Error("Stopped");
      if (failure) throw new Error(failure);
      while (i - answered >= IN_FLIGHT) await new Promise<void>((r) => { wake = r; });
      const part = samples.subarray(i * CHUNK, Math.min(samples.length, (i + 1) * CHUNK));
      const f = new Float32Array(part.length);
      // the same -1..1 floats the teleprompter feeds from the mic
      for (let j = 0; j < part.length; j++) f[j] = part[j] / 32768;
      rec.acceptWaveformFloat(f, RATE);
      if (i % 20 === 0) onProgress(t("editor.captions.listening"), chunks ? answered / chunks : null);
    }
    while (answered < chunks && !failure) await new Promise<void>((r) => { wake = r; });
    if (failure) throw new Error(failure);
    // the words still held by the recognizer
    await new Promise<void>((r) => { finalDone = r; rec.retrieveFinalResult(); setTimeout(r, 10_000); });
    onProgress(t("editor.captions.listening"), 1);
  } finally {
    try { rec.remove(); } catch { /* the worker may be gone */ }
  }
  return words.sort((a, b) => a.start - b.start);
}
