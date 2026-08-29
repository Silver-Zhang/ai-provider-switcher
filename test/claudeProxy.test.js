const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const { startClaudeProxy } = require("../out/claudeProxy.js");

/** A fake upstream that records the last request and echoes the model it saw. */
function startUpstream() {
  return new Promise((resolve) => {
    const received = { method: "", path: "", model: null, headers: {} };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.method = req.method;
        received.path = req.url;
        received.headers = req.headers;
        let model = null;
        try {
          model = JSON.parse(Buffer.concat(chunks).toString("utf8")).model ?? null;
        } catch {
          // Not JSON.
        }
        received.model = model;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ receivedModel: model }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, received, port: server.address().port, stop: () => server.close() });
    });
  });
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: payload
          ? { "content-type": "application/json", "content-length": payload.length }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("rewrites the model and forwards to the upstream relay", async () => {
  const upstream = await startUpstream();
  const proxy = await startClaudeProxy({
    port: 0,
    resolve: (model) =>
      model === "claude-opus-5"
        ? { baseUrl: `http://127.0.0.1:${upstream.port}`, model: "gpt-5.6" }
        : undefined
  });
  try {
    const response = await request(
      proxy.port,
      "POST",
      "/v1/messages",
      { model: "claude-opus-5", messages: [] }
    );
    assert.equal(response.status, 200);
    assert.equal(upstream.received.model, "gpt-5.6");
    assert.equal(upstream.received.path, "/v1/messages");
    // The response streams back untouched.
    assert.deepEqual(JSON.parse(response.body), { receivedModel: "gpt-5.6" });
  } finally {
    proxy.stop();
    upstream.stop();
  }
});

test("returns 503 when no live provider can resolve the model", async () => {
  const upstream = await startUpstream();
  const proxy = await startClaudeProxy({
    port: 0,
    resolve: () => undefined
  });
  try {
    const response = await request(proxy.port, "POST", "/v1/messages", { model: "claude-opus-5" });
    assert.equal(response.status, 503);
  } finally {
    proxy.stop();
    upstream.stop();
  }
});

test("a request without a model field is not a Messages request", async () => {
  const proxy = await startClaudeProxy({
    port: 0,
    resolve: () => ({ baseUrl: "http://127.0.0.1:1", model: "x" })
  });
  try {
    const post = await request(proxy.port, "POST", "/v1/messages", { not: "a model" });
    assert.equal(post.status, 404);
    const get = await request(proxy.port, "GET", "/v1/models");
    assert.equal(get.status, 404);
  } finally {
    proxy.stop();
  }
});

test("an opaque Desktop catalogue route resolves to its exact upstream model", async () => {
  const upstream = await startUpstream();
  const safeRoute = "claude-route-0123456789abcdef";
  const proxy = await startClaudeProxy({
    port: 0,
    resolve: (model) =>
      model.replace(/\[1m\]$/i, "") === safeRoute
        ? { baseUrl: `http://127.0.0.1:${upstream.port}`, model: "claude-opus-5-2026" }
        : undefined
  });
  try {
    const response = await request(proxy.port, "POST", "/v1/messages", {
      model: `${safeRoute}[1M]`, messages: []
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.received.model, "claude-opus-5-2026");
  } finally {
    proxy.stop();
    upstream.stop();
  }
});
