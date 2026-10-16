import { createRoot } from "react-dom/client";
import "./styles.css";

// OWNED BY: teleprompter agent. The prompter window's own React root.
createRoot(document.getElementById("root")!).render(<div className="placeholder">Prompter</div>);
