const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const {
  formatProviderUsageSummary,
  getJsonPathValue,
  hasProviderUsage,
  normalizeUsageConfiguration,
  parseProviderUsage,
  requestProviderUsage,
  validateUsageEndpoint
} = require("../out/providerUsage.js");

test("parses common five-hour, weekly, and balance usage fields", () => {
  const snapshot = parseProviderUsage(
    "provider-1",
    "codex",
    JSON.stringify({
      quota: {
        five_hour: { used_percent: 37, reset_at: "2026-07-31T18:00:00Z" },
        weekly: { remaining_percent: 62, reset_at: "2026-08-04T00:00:00Z" }
      },
      balance: { remaining: 18.42, currency: "$" }
    }),
    {},
    { endpoint: "https://api.example.com/usage" },
    "2026-07-31T12:00:00Z"
  );

  assert.equal(snapshot.source, "usageApi");
  assert.deepEqual(snapshot.balance, { remaining: 18.42, used: undefined, currency: "$" });
  assert.deepEqual(snapshot.windows[0], {
    name: "5 小时",
    usedPercent: 37,
    remainingPercent: 63,
    resetsAt: "2026-07-31T18:00:00Z"
  });
  assert.deepEqual(snapshot.windows[1], {
    name: "周",
    usedPercent: 38,
    remainingPercent: 62,
    resetsAt: "2026-08-04T00:00:00Z"
  });
  assert.match(formatProviderUsageSummary(snapshot), /5 小时剩余 63%/);
  assert.match(formatProviderUsageSummary(snapshot), /周剩余 62%/);
  assert.match(formatProviderUsageSummary(snapshot), /余额 \$18\.42/);
});

test("uses configured JSON paths including array indexes", () => {
  const body = JSON.stringify({ data: { limits: [{ consumed: "25%", reset: 12345 }], money: "¥88.50" } });
  const configuration = normalizeUsageConfiguration({
    endpoint: "https://api.example.com/quota",
    fiveHourUsedPercentPath: "data.limits[0].consumed",
    fiveHourResetPath: "data.limits[0].reset",
    balanceRemainingPath: "data.money"
  });
  const snapshot = parseProviderUsage("provider-2", "claude", body, {}, configuration);
  assert.equal(getJsonPathValue(JSON.parse(body), "$.data.limits[0].consumed"), "25%");
  assert.equal(snapshot.windows[0].remainingPercent, 75);
  assert.equal(snapshot.windows[0].resetsAt, "12345");
  assert.equal(snapshot.balance.remaining, 88.5);
});

test("parses request and token rate-limit response headers", () => {
  const snapshot = parseProviderUsage("provider-3", "codex", "", {
    "X-RateLimit-Limit-Requests": "500",
    "x-ratelimit-remaining-requests": "237",
    "x-ratelimit-reset-requests": "2m",
    "x-ratelimit-limit-tokens": "1000000",
    "x-ratelimit-remaining-tokens": "841000"
  });
  assert.equal(snapshot.source, "responseHeaders");
  assert.deepEqual(snapshot.rateLimits, [
    { resource: "requests", limit: 500, remaining: 237, reset: "2m" },
    { resource: "tokens", limit: 1000000, remaining: 841000, reset: undefined }
  ]);
  assert.equal(hasProviderUsage(snapshot), true);
  assert.match(formatProviderUsageSummary(snapshot), /请求剩余 237/);
  assert.match(formatProviderUsageSummary(snapshot), /Token剩余 841000/);
});

test("returns an empty snapshot when no compatible usage data exists", () => {
  const snapshot = parseProviderUsage("provider-4", "claude", JSON.stringify({ hello: "world" }), {});
  assert.equal(hasProviderUsage(snapshot), false);
  assert.equal(formatProviderUsageSummary(snapshot), "额度：未识别到兼容数据");
});

test("validates usage endpoints and rejects embedded credentials", () => {
  assert.equal(validateUsageEndpoint("https://api.example.com/usage"), "https://api.example.com/usage");
  assert.throws(() => validateUsageEndpoint("file:///tmp/usage.json"), /http:\/\//);
  assert.throws(() => validateUsageEndpoint("https://user:secret@example.com/usage"), /用户名或密码/);
});

test("rejects invalid JSON from a configured usage API", () => {
  assert.throws(
    () => parseProviderUsage("provider-5", "codex", "not-json", {}, { endpoint: "https://api.example.com/usage" }),
    /不是有效 JSON/
  );
});

test("classifies HTML login or proxy pages as a distinct usage error", () => {
  assert.throws(
    () => parseProviderUsage("provider-html", "claude", "<!DOCTYPE html><html><body>login</body></html>", {}, { endpoint: "https://api.example.com/usage" }),
    /返回了 HTML.*登录页/
  );
});

test("normalizes saved usage mappings without exposing credentials", () => {
  const configuration = normalizeUsageConfiguration({
    endpoint: "https://api.example.com/usage",
    balanceRemainingPath: " data.balance ",
    ignored: "secret-token"
  });
  assert.deepEqual(configuration, {
    endpoint: "https://api.example.com/usage",
    balanceRemainingPath: "data.balance"
  });
});

test("requests a real read-only usage endpoint with provider authentication", async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer test-token");
    assert.equal(request.headers["x-api-key"], "test-token");
    response.writeHead(200, {
      "content-type": "application/json",
      "x-ratelimit-remaining-requests": "99"
    });
    response.end(JSON.stringify({ quota: { weekly: { used_percent: 12 } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.equal(typeof address, "object");

  const configuration = { endpoint: `http://127.0.0.1:${address.port}/usage` };
  const snapshot = await requestProviderUsage(
    configuration.endpoint,
    "test-token",
    "provider-network",
    "claude",
    configuration
  );
  assert.equal(snapshot.windows[0].remainingPercent, 88);
  assert.equal(snapshot.rateLimits[0].remaining, 99);
});
