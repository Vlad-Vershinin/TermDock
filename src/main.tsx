import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Disable the browser context menu outside inputs/terminal (the terminal handles its own).
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea")) e.preventDefault();
});

// No StrictMode: its double-mount would open every SSH session twice in dev.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
