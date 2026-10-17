import { createRoot } from "react-dom/client";
import { t } from "@shared/i18n";
import { initLang, useLang } from "./i18n";
import { DrawStrokes, DrawToolbar } from "./modules/draw/Overlay";

// OWNED BY: shell agent. The drawing windows' own React root: the strokes (recorded) or the toolbar (hidden from capture).
const part = new URLSearchParams(location.search).get("part");

function Root() {
  useLang();
  if (part === "toolbar") document.title = t("draw.toolbarWindowTitle");
  return part === "toolbar" ? <DrawToolbar /> : <DrawStrokes />;
}

void initLang().then(() => createRoot(document.getElementById("root")!).render(<Root />));
