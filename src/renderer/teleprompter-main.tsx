import { createRoot } from "react-dom/client";
import "./styles.css";
import { initLang, useLang } from "./i18n";
import { PrompterApp } from "./modules/teleprompter/PrompterView";

// OWNED BY: teleprompter agent. The prompter window's own React root.
function Root() { useLang(); return <PrompterApp />; }

void initLang().then(() => createRoot(document.getElementById("root")!).render(<Root />));
