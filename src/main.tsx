import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

const useVisualHarness = new URLSearchParams(window.location.search).has("visualHarness");

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  const Component = useVisualHarness
    ? (await import("./visual-harness")).VisualHarness
    : (await import("./App")).App;

  root.render(
    <React.StrictMode>
      <Component />
    </React.StrictMode>
  );
}

void bootstrap();
