import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@tessera/ui/styles.css";
import "./styles.css";
import App from "./App";
import { initializeI18n } from "./i18n";

initializeI18n();

const isMacOS = navigator.userAgent.toLowerCase().includes("macintosh");
document.documentElement.dataset.platform = isMacOS ? "macos" : "other";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
