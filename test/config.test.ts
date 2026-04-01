import { describe, it, expect } from "vitest";
import { sanitizeName, socketPath } from "../src/config";

describe("sanitizeName", () => {
  it("passes through simple names", () => {
    expect(sanitizeName("my-project")).toBe("my-project");
    expect(sanitizeName("foo_bar")).toBe("foo_bar");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeName("my project")).toBe("my_project");
    expect(sanitizeName("foo.bar")).toBe("foo_bar");
    expect(sanitizeName("a:b:c")).toBe("a_b_c");
  });

  it("strips leading dashes", () => {
    expect(sanitizeName("-leading")).toBe("leading");
    expect(sanitizeName("---multi")).toBe("multi");
  });

  it("truncates to 32 characters", () => {
    expect(sanitizeName("a".repeat(50))).toBe("a".repeat(32));
  });

  it("returns 'vscode' for empty input", () => {
    expect(sanitizeName("")).toBe("vscode");
    expect(sanitizeName("---")).toBe("vscode");
  });
});

describe("socketPath", () => {
  it("builds correct socket path", () => {
    expect(socketPath("/tmp/dtach-persist/abc", 0)).toBe(
      "/tmp/dtach-persist/abc/0.sock",
    );
    expect(socketPath("/tmp/dtach-persist/abc", 3)).toBe(
      "/tmp/dtach-persist/abc/3.sock",
    );
  });
});
