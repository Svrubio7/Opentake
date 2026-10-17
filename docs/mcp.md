# Use OpenTake with Claude or Codex

OpenTake comes with an MCP server, so you can edit your recordings by asking Claude (Desktop or Code) or Codex in plain words:

- "Cut the pauses and the ums out of my last take."
- "Fix the captions: it's OpenTake, not open take."
- "Find the best 60 seconds and export it for Reels with captions."
- "Add chapters where I switch topics, and give me the list for YouTube."
- "Open this take in FilmCraft."

The server runs on your computer and works on your take folders. It changes only a take's edit (`edit.json`), captions (`captions.json`), title, chapters and caption style, never the recording itself. Every change shows in the editor and can be undone. Nothing is deleted and no file is overwritten.

## Connect

Open OpenTake, go to **Settings**, then **Use with Claude or Codex**.

- **Claude Desktop**: press *Set up Claude Desktop*. OpenTake backs up `claude_desktop_config.json`, adds itself and keeps every other server and setting. Quit Claude Desktop completely and open it again.
- **Claude Code**: copy the `claude mcp add opentake ...` command and run it in a terminal.
- **Codex**: copy the block into `~/.codex/config.toml`.
- **Test connection** starts the server the same way the assistant will and lists your takes.

The commands show the exact paths for your copy of OpenTake. The server is OpenTake's own executable run in Node mode (`ELECTRON_RUN_AS_NODE=1`) on `resources/mcp/opentake-mcp.cjs`, so nothing else needs installing.

By hand, the Claude Desktop entry looks like this on Windows:

```json
{
  "mcpServers": {
    "opentake": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\OpenTake\\OpenTake.exe",
      "args": ["C:\\Users\\you\\AppData\\Local\\Programs\\OpenTake\\resources\\mcp\\opentake-mcp.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

On macOS the command is `/Applications/OpenTake.app/Contents/MacOS/OpenTake` and the script is in `/Applications/OpenTake.app/Contents/Resources/mcp/`. The portable Windows build and the Linux AppImage unpack to a new folder each time, so for them OpenTake keeps a copy of the script in its data folder and the command is the `.exe` or `.AppImage` itself; set it up again if you move that file. The portable copy is not tested with assistants yet: use the installer for this.

## Tools

All times are seconds on the take's own recording clock, unless a tool says otherwise. A take is named by its id from `list_takes`, or `latest`.

| Tool | What it does |
|---|---|
| `list_takes` | Your takes, newest first, with length, mode, frame, and whether each has cuts, captions, chapters and exports |
| `get_take` | One take in detail: files, frame, frame rate, clicks, scene switches, overlays, current cuts, captions, chapters, exports |
| `get_transcript` | The words with times. Makes captions first when the take has none (on your computer, English or Spanish) |
| `get_frame` | A picture of one moment (PNG, 1280 wide by default) so the assistant can see the screen |
| `find_moments` | Silences, long pauses, filler words, scene switches and bursts of clicks |
| `set_cuts`, `cut_ranges`, `keep_ranges` | Replace the edit, cut stretches out, or keep only some stretches |
| `remove_silences` | Cut long pauses, leaving a short natural one (`dry_run` to preview) |
| `remove_filler_words` | Cut um, uh, er, eh, este, o sea and your own words (`dry_run` to preview) |
| `edit_captions` | Replace text, find and replace, split, merge, retime, delete lines |
| `set_caption_style` | Clean, boxed or social, top or bottom, for burned-in captions |
| `set_title`, `add_chapters` | Name the take; mark chapters (also returns a YouTube chapter list) |
| `undo_change` | Undo one change, or the latest |
| `export_take` | Export a video with every preset, format, quality, target size and captions option the app has. Returns a job |
| `get_job` | Follow an export, a captions job, an import or a timeline export |
| `export_timeline` | Write the take for another editor: `.otio`, `.fcpxml` and `.srt` (see below) |
| `import_video` | Copy a video file you name into your recordings as a new take |

Prompts: *Tighten my last take*, *Make a 60 s vertical cut with captions*, *Clean up ums and pauses*.

## What needs the app

Reads, cuts, caption fixes, chapters, titles, timeline exports and imports work on the take folders directly, with or without OpenTake open. Two things run inside the app: making captions (the speech model runs there) and video exports (they use the app's own export and show their progress in it). If OpenTake is closed, the server starts it in the background with no window; it quits by itself after 10 quiet minutes, and opening OpenTake normally shows the window.

While the app is open, a change the assistant makes shows at once in the takes list and in an open editor, as one step you can undo with Ctrl+Z.

## Safety

- Takes are found only inside the recordings folder Settings points at. Take ids and paths are checked on every call.
- `import_video` reads only the file you name, copies it (the original is never moved or changed) and checks it is a real video first.
- Exports and timelines go where your Settings say, under a free name like `name (2).mp4`. Nothing is ever overwritten.
- Every call is listed under **Settings, Use with Claude or Codex, Assistant activity**, with Undo for edits. Undo is refused when you changed the take again afterwards, so your own edits are never thrown away; a file the assistant created is moved to the take's `.assistant` folder, not deleted.
- The app's bridge listens on 127.0.0.1 only, on a random port, and asks for a secret token kept in OpenTake's data folder. Requests from web pages are refused.
- What the assistant reads (a transcript, a frame) goes to it as part of your chat, like anything else you show it.

## Open in an editor

`export_timeline`, the Takes list's *Open in an editor* button and the export dialog write:

- an **OpenTimelineIO** file (`.otio`) for FilmCraft, DaVinci Resolve, and other editors that read OTIO;
- an **FCPXML 1.10** file (`.fcpxml`) for Final Cut Pro, DaVinci Resolve and FilmCraft;
- the captions as an **.srt** on the edited timeline.

The cuts are clips back to back, at the take's frame rate. Clicks, scene switches, chapters and captions are markers. *As recorded* puts the composite on one video and one audio track; *Separate tracks* puts the screen, the camera (full size, above the screen) and the computer sound on their own tracks. The media stay where they are; a WebM without an index gets an indexed copy next to it so editors can seek. Premiere and Final Cut cannot read WebM: turn on *MP4 copies* for them.

Tested with FilmCraft 0.8.0 (headless import of both files: clips, cuts, durations, frame size and markers) and the OpenTimelineIO 0.18 library. OTIO has no caption track, so captions arrive as markers; import the `.srt` as a caption track.
