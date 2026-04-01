import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listSockets, findNextIndex, socketFileExists } from "../src/dtach";

describe("listSockets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for empty directory", () => {
    expect(listSockets(tmpDir)).toEqual([]);
  });

  it("returns empty array for non-existent directory", () => {
    expect(listSockets("/nonexistent/path")).toEqual([]);
  });

  it("ignores non-.sock files", () => {
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "");
    expect(listSockets(tmpDir)).toEqual([]);
  });
});

describe("findNextIndex", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 for empty directory", () => {
    expect(findNextIndex(tmpDir)).toBe(0);
  });
});

describe("socketFileExists", () => {
  it("returns false for non-existent path", () => {
    expect(socketFileExists("/nonexistent/path/0.sock")).toBe(false);
  });
});
