/**
 * The environment, as a server: the copilot route of Danish Bricks Builder (env/route.ts,
 * unchanged apart from where it records sessions) served by plain Node, no web framework.
 *
 *   ANTHROPIC_API_KEY=… npx tsx env/server.ts [--port 8788]
 *
 * Then env/run.ts drives it: one POST per session, Server-Sent Events back. Sessions are
 * recorded under sessions/<runId>/ (run.json, toolLog.jsonl, snapshots/, blobs/) — the
 * harness's own format, which serve.py shows. The agent's "eyes" (render_view) need Chrome
 * and the packed part files (sh fetch-data.sh --eyes); without them the route offers no
 * render tool, which is the --eyes=off condition.
 */
import { createServer } from "node:http";
import { POST } from "./route";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 8788);

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/api/copilot")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "POST /api/copilot" }));
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://localhost:${port}${req.url}`, { method: "POST", headers, body: Buffer.concat(chunks) });
  try {
    const response = await POST(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`environment at http://localhost:${port}/api/copilot  (key: ${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING — export ANTHROPIC_API_KEY"})`);
});
