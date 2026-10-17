// Lip-sync proof source (measure.ts reads the files). Injected before the app loads: every camera and microphone the app opens is a
// synthetic pair on ONE clock. Each video frame carries the moment it was drawn (performance.now(),
// whole ms, 20 bits) as a grid of black and white blocks; the sound carries a 100 ms 1 kHz tone
// starting at every performance time k*1000 ms, placed on the audio clock. A file's lip sync is then
// read from the file alone: when its pictures say they were drawn, against when its tones sound.
// Nothing is connected to the speakers.
(() => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const W = 1280, H = 720;
  // the code sits in the centre square (what a round bubble keeps): 6 x 4 cells of 100 x 150 px
  const GX = 340, GY = 60, CW = 100, CH = 150, COLS = 6, ROWS = 4;
  let syn = null;
  const make = () => {
    if (syn) return syn;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d");
    const vs = c.captureStream(60);
    const ac = new AudioContext({ sampleRate: 48000 });
    const dest = ac.createMediaStreamDestination();
    // a 150 ms chirp, 300 to 3000 Hz under a Hann window: found by a matched filter even after a
    // gate, a compressor or a noise suppressor has reshaped its loudness
    const LEN = Math.round(0.15 * 48000);
    const chirp = ac.createBuffer(1, LEN, 48000);
    const d = chirp.getChannelData(0);
    for (let i = 0; i < LEN; i++) { const t = i / 48000, T = LEN / 48000; d[i] = 0.5 * Math.sin(2 * Math.PI * (300 * t + ((3000 - 300) / (2 * T)) * t * t)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (LEN - 1))); }
    let next = 0;
    window.__synTicks = 0;
    const tick = () => {
      window.__synTicks++;
      const p = performance.now();
      const ms = Math.floor(p) & 0xfffff;
      g.fillStyle = "#808080";
      g.fillRect(0, 0, W, H);
      // row 0: a white marker, bits 19..16, a black marker (the markers show a mirrored picture);
      // rows 1-3: bits 15..0, then a white and a black cell
      const cells = [1];
      for (let i = 19; i >= 16; i--) cells.push((ms >> i) & 1);
      cells.push(0);
      for (let i = 15; i >= 0; i--) cells.push((ms >> i) & 1);
      cells.push(1, 0);
      for (let r = 0; r < ROWS; r++) for (let q = 0; q < COLS; q++) {
        g.fillStyle = cells[r * COLS + q] ? "#ffffff" : "#000000";
        g.fillRect(GX + q * CW, GY + r * CH, CW, CH);
      }
      // the tones of the next two seconds, placed on the audio clock from the same reading
      const c0 = ac.currentTime;
      for (let k = Math.max(next, Math.ceil(p / 1000)); k * 1000 < p + 2000; k++) {
        const at = c0 + (k * 1000 - p) / 1000;
        if (at <= c0 + 0.005) continue;
        const src = new AudioBufferSourceNode(ac, { buffer: chirp });
        src.connect(dest);
        src.start(at);
        next = k + 1;
      }
    };
    const wk = new Worker(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),4)"], { type: "text/javascript" })));
    wk.onmessage = tick;
    void ac.resume();
    syn = { video: vs.getVideoTracks()[0], audio: dest.stream.getAudioTracks()[0], ac };
    window.__syn = syn;
    return syn;
  };
  navigator.mediaDevices.getUserMedia = async (cons) => {
    const v = cons && cons.video;
    if (v && v.mandatory && v.mandatory.chromeMediaSource) return real(cons);
    const s = make();
    const tracks = [];
    if (cons.video) tracks.push(s.video.clone());
    if (cons.audio) tracks.push(s.audio.clone());
    return new MediaStream(tracks);
  };
})();
