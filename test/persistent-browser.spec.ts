import { test as base } from "@playwright/test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

declare global {
  interface Window {
    runPersistenceCase(name: string): Promise<void>;
  }
}

const root = resolve(__dirname, "..");

// Own a direct Bun child so teardown signals only its recorded PID, never a process group.
const test = base.extend<Record<never, never>, { serverURL: string }>({
  serverURL: [
    async ({ browser }, use) => {
      const server = spawn("bun", ["run", "test/browser-server.ts"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      let errors = "";
      server.stderr.on("data", (chunk) => {
        errors += chunk.toString();
      });
      try {
        const address = await new Promise<string>((resolveReady, reject) => {
          const timer = setTimeout(() => reject(new Error(`Browser test server did not start: ${errors}`)), 10000);
          const ready = (error: Error | null, url = ""): void => {
            clearTimeout(timer);
            if (error !== null) {
              reject(error);
            } else {
              resolveReady(url);
            }
          };
          server.once("error", (error) => ready(error));
          server.once("exit", (code) => ready(new Error(`Browser test server exited (${code}): ${errors}`)));
          server.stdout.on("data", (chunk) => {
            output += chunk.toString();
            const match = output.match(/Browser persistence cases: (http:\/\/127\.0\.0\.1:\d+\/)/);
            if (match !== null) {
              ready(null, match[1]);
            }
          });
        });
        console.log(`Browser test server PID ${server.pid}, Chrome ${browser.version()}`);
        await use(address);
      } finally {
        if (typeof server.pid === "number" && server.exitCode === null && server.signalCode === null) {
          await new Promise<void>((resolveStopped, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Browser test server PID ${server.pid} did not stop after SIGTERM`)),
              5000
            );
            server.once("exit", () => {
              clearTimeout(timer);
              resolveStopped();
            });
            server.kill("SIGTERM");
          });
          console.log(`Browser test server PID ${server.pid} stopped`);
        }
      }
    },
    { scope: "worker" }
  ]
});

for (const name of [
  "invalid-and-recovery",
  "collection-plugins",
  "transaction-isolation",
  "initial-load-and-legacy",
  "watch-defers-during-transaction",
  "quota-rollback",
  "same-document-policy",
  "cross-document-watch",
  "crud-and-reopen",
  "denied-storage-and-memory-core"
]) {
  test(name, async ({ page, serverURL }) => {
    await page.goto(serverURL);
    await page.evaluate((caseName) => window.runPersistenceCase(caseName), name);
  });
}
