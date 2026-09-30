import { execSync } from "node:child_process";
import { createServer } from "node:net";

const port = Number(process.env.PORT ?? "23707");

function canListen(portToCheck) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(portToCheck, "0.0.0.0");
  });
}

function killPortWindows(portToKill) {
  try {
    const output = execSync(`netstat -ano | findstr :${portToKill}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts.at(-1));
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`[dev] freed port ${portToKill} (pid ${pid})`);
      } catch {
        // Process may already have exited.
      }
    }
  } catch {
    // findstr exits 1 when nothing matches.
  }
}

if (!(await canListen(port))) {
  if (process.platform === "win32") killPortWindows(port);
  else {
    try {
      execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
    } catch {
      // Best-effort.
    }
  }
}

const { spawn } = await import("node:child_process");
const child = spawn("pnpm exec vite --config vite.config.ts --host 0.0.0.0", {
  stdio: "inherit",
  shell: true,
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
