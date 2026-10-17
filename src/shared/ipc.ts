// Every IPC channel name lives here. Each module adds channels only to its own block.
// The preload forwards only channels that start with "take:".
export const IPC = {
  // record module: screen sources, global click tracking, saving, export
  screenSources: "take:screen:sources",
  clicksStart: "take:clicks:start",
  clicksStop: "take:clicks:stop",
  clickEvent: "take:clicks:event",
  saveRecording: "take:record:save",
  exportVideo: "take:record:export",
  exportProgress: "take:record:export-progress",
  openRecordingsFolder: "take:record:open-folder",
  cursorEvent: "take:clicks:cursor",
  recordBegin: "take:record:begin",
  recordChunk: "take:record:chunk",
  recordShortcut: "take:record:shortcut",
  exportCancel: "take:record:export-cancel",
  takesList: "take:record:takes",
  takeDelete: "take:record:take-delete",
  /** renderer -> main: start or stop the keystroke overlay's global key hook */
  keysStart: "take:keys:start",
  keysStop: "take:keys:stop",
  /** main -> renderer: one key press for the keystroke overlay (never written to disk) */
  keysEvent: "take:keys:event",
  takeReveal: "take:record:take-reveal",
  /** free space on the drive that holds the recordings */
  diskSpace: "take:record:disk",
  /** whether this system can record the computer's own sound */
  systemAudioSupport: "take:system-audio:support",
  /** mute this window's own playback so the computer sound capture does not record it */
  muteOwnAudio: "take:system-audio:mute-own",
  // teleprompter module: the second window and the state relay between windows
  prompterOpen: "take:prompter:open",
  prompterClose: "take:prompter:close",
  prompterState: "take:prompter:state",
  prompterCommand: "take:prompter:command",
  /** prompter window -> controller: the word the reader is on */
  prompterPosition: "take:prompter:position",
  /** controller -> main: window options (opacity, click-through, snap, capture hiding) */
  prompterWindow: "take:prompter:window",
  /** main -> controller: the prompter window opened or closed */
  prompterWindowStatus: "take:prompter:window-status",
  /** controller -> main: the in-window overlay is showing, keep the global shortcuts on */
  prompterShortcuts: "take:prompter:shortcuts",
  // shell: auto update
  /** main -> renderers: the updater's status */
  updateStatus: "take:update:status",
  updateCheck: "take:update:check",
  /** restart into the downloaded version (refused while busy) */
  updateInstall: "take:update:install",
  /** main window -> main: a take is recording or exporting */
  updateBusy: "take:update:busy",
  updateOpenRelease: "take:update:open-release",
  // shell: drawing on the screen
  /** main -> windows: drawing mode and preferences */
  drawStatus: "take:draw:status",
  /** turn drawing mode on, off or toggle it (no argument) */
  drawToggle: "take:draw:toggle",
  /** change preferences (fade, tool, colour) */
  drawPrefs: "take:draw:prefs",
  /** toolbar -> main -> overlay: undo, clear */
  drawCommand: "take:draw:command",
  /** main window -> main: the display the take records, so the overlay goes there */
  drawDisplay: "take:draw:display",
  /** overlay -> main: nothing is left on screen, the window can hide */
  drawEmpty: "take:draw:empty",
} as const;
