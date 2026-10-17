import { createRoot } from "react-dom/client";
import { DrawStrokes, DrawToolbar } from "./modules/draw/Overlay";

// OWNED BY: shell agent. The drawing windows' own React root: the strokes (recorded) or the toolbar (hidden from capture).
const part = new URLSearchParams(location.search).get("part");
if (part === "toolbar") document.title = "OpenTake Drawing Tools";
createRoot(document.getElementById("root")!).render(part === "toolbar" ? <DrawToolbar /> : <DrawStrokes />);
