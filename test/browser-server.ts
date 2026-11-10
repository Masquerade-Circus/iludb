import { resolve } from "node:path";

// Run explicitly with Bun. This server never launches or terminates a browser.
const root = resolve(import.meta.dir, "..");
const routes = new Map([
  ["/", "test/persistent-browser.html"],
  ["/cases.js", "test/persistent-browser.js"],
  ["/core.js", "dist/iludb.js"],
  ["/adapter.js", "dist/plugins/local-storage.js"]
]);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const route = routes.get(new URL(request.url).pathname);
    if (typeof route !== "string") {
      return new Response("Not found", { status: 404 });
    }
    const file = Bun.file(resolve(root, route));
    if (!(await file.exists())) {
      return new Response("Build artifact unavailable", { status: 503 });
    }
    return new Response(file, { headers: { "Cache-Control": "no-store" } });
  }
});

console.log(`Browser persistence cases: ${server.url}`);
