import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "./page";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalHostedDemo = process.env.NEXT_PUBLIC_HOSTED_DEMO;

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
  if (originalHostedDemo === undefined) {
    delete process.env.NEXT_PUBLIC_HOSTED_DEMO;
  } else {
    process.env.NEXT_PUBLIC_HOSTED_DEMO = originalHostedDemo;
  }
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

describe("Home deployment boundary", () => {
  it("makes the GitHub Pages capability boundary visible", () => {
    process.env.NEXT_PUBLIC_HOSTED_DEMO = "true";
    setWindowOrigin();

    const markup = renderToString(<Home />);

    expect(markup).toContain("Static demo");
    expect(markup).toContain("Public repos only");
    expect(markup).toContain("Public PR and fork inspection");
    expect(markup).toContain("Available here");
    expect(markup).toContain("Merge-tree and rebase projection");
    expect(markup).toContain("GitHub App and webhooks");
    expect(markup).toContain("Server-only");
    expect(markup).toContain("Enter server URL");
    expect(markup).not.toContain(
      "https://your-host.example.com/api/github/webhook",
    );
  });

  it("does not show the static-demo badge in local or server mode", () => {
    delete process.env.NEXT_PUBLIC_HOSTED_DEMO;
    setWindowOrigin();

    const markup = renderToString(<Home />);

    expect(markup).not.toContain("Static demo capabilities");
    expect(markup).toContain("Read-only");
  });
});
