import { createRoot } from "react-dom/client";
import { t } from "@shared/i18n";
import { initLang, useLang } from "./i18n";
import { DrawStrokes, DrawToolbar } from "./modules/draw/Overlay";

// OWNED BY: shell agent. The drawing windows' own React root: the strokes (recorded) or the toolbar (hidden from capture).
const part = new URLSearchParams(location.search).get("part");

function Root() {
  useLang();
  // the page's <title> would replace the window's translated one: both parts set theirs, in the current language
  document.title = t(part === "toolbar" ? "draw.toolbarWindowTitle" : "draw.strokesWindowTitle");
  return part === "toolbar" ? <DrawToolbar /> : <DrawStrokes />;
}

void initLang().then(() => createRoot(document.getElementById("root")!).render(<Root />));
