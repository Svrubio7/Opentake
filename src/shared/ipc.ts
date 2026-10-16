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
  // teleprompter module: the second window and the state relay between windows
  prompterOpen: "take:prompter:open",
  prompterClose: "take:prompter:close",
  prompterState: "take:prompter:state",
  prompterCommand: "take:prompter:command",
} as const;
