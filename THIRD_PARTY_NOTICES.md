# Third-party notices

OpenTake is released under the MIT licence (see `LICENSE`). It ships with the software and data below, each under its own licence. Versions are the ones in `package-lock.json` when this file was written; licences were read from each package's own `package.json`, licence file or source headers.

## Programs shipped as separate files

### FFmpeg (through ffmpeg-static 5.3.0)

- What: the `ffmpeg` executable, used to export recordings to MP4. It is shipped unmodified, as a separate program next to the app (`resources/app.asar.unpacked/node_modules/ffmpeg-static/`), and OpenTake runs it as a child process. OpenTake does not link against it.
- Licence: **GPL-3.0** (the static builds include GPL components). The full licence text and build notes ship beside the binary (`ffmpeg.LICENSE` / `ffmpeg.exe.LICENSE`, `*.README`).
- Binary release used by ffmpeg-static: tag `b6.1.1` from https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1 (FFmpeg 6.1.1). Windows builds come from https://www.gyan.dev/ffmpeg/builds/, macOS builds from https://evermeet.cx/pub/ffmpeg/ (x64) and https://osxexperts.net/ (arm64), Linux builds from https://johnvansickle.com/ffmpeg/.
- FFmpeg source code: https://ffmpeg.org/download.html (release 6.1.1: https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz). Under the GPL you may ask Quetzal (hello@quetzaltech.app) for the corresponding source of the exact binary we ship for three years from the release date; we will point you to or send the source archive.
- ffmpeg-static itself (the small loader script): GPL-3.0-or-later, https://github.com/eugeneware/ffmpeg-static.

### uiohook-napi 1.5.5 and libuiohook

- What: a native Node addon that reports global mouse clicks so recordings can zoom where you click. Loaded at runtime from `app.asar.unpacked`.
- uiohook-napi: MIT, Copyright (c) 2020 Alexander Drozdov, https://github.com/SnosMe/uiohook-napi
- libuiohook (compiled into the addon): **LGPL-3.0-or-later**, Copyright (C) 2006-2023 Alexander Barker, https://github.com/kwhat/libuiohook. The addon is a separate shared library file that can be replaced; its source is included in the uiohook-napi package.
- node-gyp-build 4.8.4 (loads the addon): MIT, https://github.com/prebuild/node-gyp-build

## Libraries bundled into the app

| Package | Version | Licence | Source |
|---|---|---|---|
| electron (runtime) | 44.8.0 | MIT | https://github.com/electron/electron |
| react | 19.3.1 | MIT | https://github.com/facebook/react |
| react-dom | 19.3.1 | MIT | https://github.com/facebook/react |
| scheduler | 0.28.0 | MIT | https://github.com/facebook/react |
| zustand | 5.0.15 | MIT | https://github.com/pmndrs/zustand |
| lucide-react | 1.58.0 | ISC | https://github.com/lucide-icons/lucide |
| geist (font) | 1.8.1 | SIL Open Font License 1.1 | https://github.com/vercel/geist-font |
| @mediapipe/tasks-vision (JS + WebAssembly) | 1.1.1 | Apache-2.0 | https://github.com/google-ai-edge/mediapipe |
| @sapphi-red/web-noise-suppressor | 0.4.1 | MIT | https://github.com/sapphi-red/web-noise-suppressor |
| vosk-browser (JS + WebAssembly) | 0.0.8 | Apache-2.0 | https://github.com/ccoreilly/vosk-browser |

Electron includes Chromium, Node.js and other components under their own licences. Their notices ship with every build in `LICENSES.chromium.html` and `LICENSE.electron.txt` next to the OpenTake executable.

### Inside @sapphi-red/web-noise-suppressor

- RNNoise (Xiph.Org Foundation, Jean-Marc Valin): BSD-3-Clause, https://github.com/xiph/rnnoise, compiled to WebAssembly by https://github.com/shiguredo/rnnoise-wasm (Apache-2.0).
- SpeexDSP preprocess (Xiph.Org Foundation, Jean-Marc Valin, Analog Devices, CSIRO, David Rowe, EpicGames, Jutta Degener and Carsten Bormann): BSD-3-Clause, https://github.com/xiph/speexdsp, compiled by https://github.com/sapphi-red/speex-preprocess-wasm. The BSD notice is embedded in the shipped worklet file.

### Inside vosk-browser

- Vosk API (Alpha Cephei Inc): Apache-2.0, https://github.com/alphacep/vosk-api
- Kaldi: Apache-2.0, https://github.com/kaldi-asr/kaldi
- OpenFst: Apache-2.0, https://www.openfst.org
- CLAPACK / OpenBLAS: BSD-3-Clause
- blueimp-md5 (Sebastian Tschan): MIT; tslib (Microsoft): 0BSD

## Models and data

| File | Licence | Source |
|---|---|---|
| `vosk-model-small-en-us-0.15.tar.gz` | Apache-2.0, Copyright 2020 Alpha Cephei Inc | https://alphacephei.com/vosk/models |
| `vosk-model-small-es-0.3.tar.gz` | Apache-2.0 (Alpha Cephei Inc) | https://alphacephei.com/vosk/models |
| `selfie_segmenter.tflite` (MediaPipe Selfie Segmentation) | Apache-2.0 (model card: "Licensed under Apache License, Version 2.0") | https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter |
| `blaze_face_short_range.tflite` (MediaPipe BlazeFace short range) | Apache-2.0 | https://developers.google.com/edge/mediapipe/solutions/vision/face_detector |

A copy of the Apache License 2.0 is at https://www.apache.org/licenses/LICENSE-2.0.

## Build-time only (not shipped)

electron-vite, vite, @vitejs/plugin-react, typescript, vitest, electron-builder and their dependencies are used to build and test OpenTake and are not part of the installed app. The packaging config (`electron-builder.yml`) keeps every package out of the app except the three the main process loads (ffmpeg-static, uiohook-napi, node-gyp-build); everything else above reaches the app already bundled by Vite.
