import React from "react";
import { createRoot } from "react-dom/client";
import "./orb.css";
import UnderfitAssistantOrb from "../views/underfit/UnderfitAssistantOrb";

// Standalone entry: mounts the white Underfit assistant orb into underfit's own
// dashboard page (served on :8791). The bundle carries its own React, so the
// vanilla dashboard needs nothing beyond the injected #underfit-orb-root div.
function mount(): void {
  let el = document.getElementById("underfit-orb-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "underfit-orb-root";
    document.body.appendChild(el);
  }
  createRoot(el).render(React.createElement(UnderfitAssistantOrb));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
