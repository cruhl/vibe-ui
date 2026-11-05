import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app.tsx";
import { Controller } from "./app/controller.ts";
import { publishForDrivers } from "./app/driver.ts";
import { loadKeys } from "./keys/index.ts";
import { loadOmniFactory } from "./omni/index.ts";
import { currentRoute, replaceRoute } from "./route/index.ts";
import { prepareScenarios, setScenarioLauncher } from "./scenario/index.ts";
import "./styles.css";

await loadKeys();
await prepareScenarios();
const route = currentRoute();
const evaluation =
  route.eval !== null || route.jev === "mock" || route.kit !== null
    ? await import("./eval/index.ts")
    : null;
if (route.kit !== null) await evaluation?.installKit(route.kit);
const createClient = await loadOmniFactory(
  route.omni === "mock" ? { faults: route.mockFaults, delays: route.delays } : null,
);
let controller = new Controller(createClient);
publishForDrivers(controller);
if (route.kit === null) evaluation?.installEval(controller);
const root = document.getElementById("root");
const reactRoot = root === null ? null : createRoot(root);
let mounted = 0;

function render(): void {
  reactRoot?.render(
    <StrictMode>
      <App key={mounted} controller={controller} />
    </StrictMode>,
  );
}

setScenarioLauncher((scenarioID) => {
  replaceRoute({ idea: null, preset: scenarioID });
  controller = new Controller(createClient);
  publishForDrivers(controller);
  mounted++;
  render();
});
render();
