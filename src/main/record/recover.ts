// Takes the app closed on (a crash, a power cut, quitting mid-take): the chunks on disk are a playable
// recording without a length in its header. On the next launch each one gets its real length (ffmpeg
// reads it to the end without re-encoding) and is marked done and recovered.
import { lastStatsTimeMs } from "../settings-core";
import { ffmpegPath } from "./export";
import { runWatched } from "./ffmpeg-run";
import { listTakes, readMeta, writeMeta } from "./takes";

/** when this copy of the app started: takes begun after it are this session's own */
const launchedAt = Date.now();
let pass: Promise<number> | null = null;

/** Finishes every take an earlier session left open; resolves to how many. Runs once per launch. */
export function recoverTakes(): Promise<number> {
  pass ??= (async () => {
    let n = 0;
    for (const take of await listTakes().catch(() => [])) {
      if (take.status !== "recording" || take.createdAt >= launchedAt || !take.files.composite) continue;
      let durationMs: number | null = null;
      try {
        const r = await runWatched(ffmpegPath(), ["-nostdin", "-hide_banner", "-i", take.files.composite, "-map", "0", "-c", "copy", "-f", "null", "-"], {});
        durationMs = lastStatsTimeMs(r.stderr);
      } catch { /* unreadable: still listed, without a length */ }
      try {
        const meta = await readMeta(take.id);
        await writeMeta({ ...meta, status: "done", recovered: true, durationMs: durationMs ?? meta.durationMs });
        n++;
      } catch { /* folder gone meanwhile */ }
    }
    return n;
  })();
  return pass;
}
