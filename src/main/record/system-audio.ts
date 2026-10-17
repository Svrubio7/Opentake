// The computer's own sound: getDisplayMedia answered with the system loopback device. The renderer
// keeps the audio track and drops the video one (the screen picture comes from its own capture).
import { app, desktopCapturer, ipcMain, session } from "electron";
import { release } from "node:os";
import { IPC } from "../../shared/ipc";
import type { SystemAudioSupport } from "../../shared/types";
import { loopbackFeatures, mergeFeatures, systemAudioSupport } from "./system-audio-core";

/** Before app ready: macOS and Linux keep loopback capture behind Chromium features. */
export function enableLoopbackFeatures() {
  const features = loopbackFeatures(process.platform);
  if (!features.length) return;
  app.commandLine.appendSwitch("enable-features", mergeFeatures(app.commandLine.getSwitchValue("enable-features"), features));
}

export function registerSystemAudioIpc() {
  const support = systemAudioSupport(process.platform, release());

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    void desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const screen = sources[0];
      if (!screen) return callback(null);
      // a video source is part of every answer; the renderer stops it straight away
      callback(request.audioRequested && support.supported ? { video: screen, audio: "loopback" } : { video: screen });
    }, () => callback(null));
  });

  ipcMain.handle(IPC.systemAudioSupport, (): SystemAudioSupport => support);
  ipcMain.handle(IPC.muteOwnAudio, (e, muted: unknown) => { e.sender.setAudioMuted(muted === true); });
}
