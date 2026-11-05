import type { Controller } from "./controller.ts";

declare global {
  interface Window {
    /**
     * The controller of the session this page runs, published for drivers outside the page
     * (scripts through Playwright) and nothing else: no module of the app reads it.
     */
    vibeUI?: Controller;
  }
}

/** Publishes the page's controller for drivers. */
export function publishForDrivers(controller: Controller): void {
  window.vibeUI = controller;
}
