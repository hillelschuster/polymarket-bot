import { afterEach, describe, expect, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireProcessLock } from "../src/lib/processLock.js";

const lockPath = path.join(os.tmpdir(), `hermes-lock-test-${randomUUID()}.lock`);

afterEach(() => {
  delete process.env.BOT_LOCK_FILE;
  if (existsSync(lockPath)) unlinkSync(lockPath);
});

describe("process lock", () => {
  it("blocks a second live holder and can be released", () => {
    process.env.BOT_LOCK_FILE = lockPath;
    const release = acquireProcessLock("hermes-test");
    expect(() => acquireProcessLock("hermes-test")).toThrow(/already running/);
    release();
    const releaseAgain = acquireProcessLock("hermes-test");
    releaseAgain();
  });
});
