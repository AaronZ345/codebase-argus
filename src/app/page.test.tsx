import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "./page";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function setWindowOrigin(origin?: string) {
  if (!origin) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin } },
  });
}

afterEach(() => {
  vi.useRealTimers();
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("Home hydration", () => {
  it("renders the same initial markup on the server and in the browser", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));

    setWindowOrigin();
    const serverMarkup = renderToString(<Home />);
    setWindowOrigin("https://argus.example.com");
    const browserMarkup = renderToString(<Home />);

    expect(browserMarkup).toBe(serverMarkup);
  });

  it("does not put the current time into initial markup", () => {
    vi.useFakeTimers();
    setWindowOrigin();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
    const firstRender = renderToString(<Home />);
    vi.setSystemTime(new Date("2026-07-17T10:00:01.000Z"));
    const secondRender = renderToString(<Home />);

    expect(secondRender).toBe(firstRender);
  });
});
