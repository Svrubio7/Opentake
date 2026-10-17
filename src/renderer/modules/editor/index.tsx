// OWNED BY: editor agent. The take editor (cuts and captions) and the export dialog, opened from the
// Record panel's takes list. Both render over the whole window.
import { createPortal } from "react-dom";
import { useRecord } from "../record/store";
import { Editor } from "./Editor";
import { ExportDialog } from "./ExportDialog";
import { useEditor } from "./store";
import "./editor.css";

export { openEditor, openExport } from "./store";

export function EditorHost() {
  const editing = useEditor((s) => s.editing);
  const exporting = useEditor((s) => s.exporting);
  const set = useEditor((s) => s.set);
  const take = useRecord((s) => s.takes.find((t) => t.id === exporting) ?? null);
  return createPortal(
    <>
      {editing && <Editor key={editing} takeId={editing} onClose={() => set({ editing: null })} />}
      {take && <ExportDialog take={take} onClose={() => set({ exporting: null })} />}
    </>,
    document.body,
  );
}
