import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initLang, useLang } from "./i18n";
import "./styles.css";

// useLang here re-renders the whole app when the language changes (no component is memoised)
function Root() { useLang(); return <App />; }

void initLang().then(() => createRoot(document.getElementById("root")!).render(<Root />));
