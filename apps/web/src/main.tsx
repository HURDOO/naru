import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PwaShell } from "./PwaShell";
import { isStandalonePwa } from "./pwa";
import "./styles.css";

document.documentElement.dataset.naruDisplayMode = isStandalonePwa() ? "standalone" : "browser";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PwaShell>
      <App />
    </PwaShell>
  </React.StrictMode>,
);
