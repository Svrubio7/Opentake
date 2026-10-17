import { describe, expect, it } from "vitest";
import { FfmpegStalled, progressTracker, runWatched } from "./ffmpeg-run";

const node = process.execPath;
/** a child that prints -progress lines: `values` are out_time_us, one every `everyMs` */
const printer = (values: number[], everyMs: number, thenWaitMs = 0) =>
  `const v=${JSON.stringify(values)};let i=0;const t=setInterval(()=>{if(i<v.length){process.stdout.write("out_time_us="+v[i++]+"\\nprogress=continue\\n")}else{clearInterval(t);setTimeout(()=>{},${thenWaitMs})}},${everyMs});`;

describe("ffmpeg watchdog", () => {
  it("reads the progress clock across split chunks and only counts forward moves", () => {
    const t = progressTracker();
    expect(t.feed("frame=1\nout_time_us=10")).toBeNull(); // the line is not finished yet
    expect(t.feed("00000\n")).toBe(1000);
    expect(t.feed("out_time_us=1000000\n")).toBeNull(); // same position: not progress
    expect(t.feed("out_time_us=1500000\nprogress=continue\n")).toBe(1500);
  });

  it("stops a run that goes silent and says why", async () => {
    const t0 = Date.now();
    await expect(runWatched(node, ["-e", "setTimeout(()=>{},60000)"], { stallMs: 800 })).rejects.toBeInstanceOf(FfmpegStalled);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 10_000);

  it("stops a run whose clock is stuck even while it keeps printing", async () => {
    await expect(runWatched(node, ["-e", printer(Array(40).fill(500000), 100)], { stallMs: 1000 })).rejects.toThrow(/stopped making progress/);
  }, 10_000);

  it("counts raw output as activity for runs that stream data, and stops them when it stops", async () => {
    const chunks: Buffer[] = [];
    const ok = await runWatched(node, ["-e", "let i=0;const t=setInterval(()=>{process.stdout.write(Buffer.alloc(4096));if(++i>=10)clearInterval(t)},150)"], { stallMs: 600, onData: (d) => chunks.push(d) });
    expect(ok.code).toBe(0);
    expect(Buffer.concat(chunks).length).toBe(40960);
    await expect(runWatched(node, ["-e", "process.stdout.write(Buffer.alloc(10));setTimeout(()=>{},60000)"], { stallMs: 600, onData: () => {} })).rejects.toBeInstanceOf(FfmpegStalled);
  }, 15_000);

  it("leaves a run alone while its clock moves", async () => {
    const r = await runWatched(node, ["-e", printer(Array.from({ length: 20 }, (_, i) => i * 100000), 120)], { stallMs: 700 });
    expect(r.code).toBe(0);
  }, 10_000);
});
