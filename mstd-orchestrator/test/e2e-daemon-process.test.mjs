import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForLine(stream) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("child pid not reported")), 2000);
    stream.on("data", (chunk) => {
      buffered += String(chunk);
      const line = buffered.split("\n")[0]?.trim();
      if (!line) return;
      clearTimeout(timer);
      resolve(line);
    });
  });
}

describe("E2E daemon process ownership", () => {
  it("terminates an owned daemon process group including a SIGTERM-resistant child", async () => {
    const parent = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const grandchildPid = Number(await waitForLine(parent.stdout));

    try {
      const helper = await import("./support/e2e-daemon.mjs").catch(() => ({}));
      const stopOwnedProcessTree = helper.stopOwnedProcessTree ?? (async () => {});
      await stopOwnedProcessTree(parent, { termTimeoutMs: 50, killTimeoutMs: 1000 });

      for (let i = 0; i < 20 && (alive(parent.pid) || alive(grandchildPid)); i++) await sleep(25);
      expect(alive(parent.pid)).toBe(false);
      expect(alive(grandchildPid)).toBe(false);
    } finally {
      try { process.kill(-parent.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
});
