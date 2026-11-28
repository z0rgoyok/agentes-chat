import { mock } from "bun:test";

/**
 * React Native's `AppState`, driven by the test, for every test file that loads code reading it. One mock for all of
 * them: in a run of several files Bun keeps the first `react-native` mock's exports, so a second file's own mock with
 * another shape (one more export, its own listeners) never reaches the code it loads.
 */
type Listener = (state: string) => void;
export const app = { state: "active", listeners: new Set<Listener>() };
export const to = (state: string) => {
  app.state = state;
  for (const l of [...app.listeners]) l(state);
};
export const resetAppState = () => {
  app.state = "active";
  app.listeners.clear();
};

mock.module("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return app.state;
    },
    addEventListener: (_event: "change", listener: Listener) => {
      app.listeners.add(listener);
      return { remove: () => app.listeners.delete(listener) };
    },
  },
}));
