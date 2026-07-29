import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Codex Claude Bridge landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Codex Claude Bridge<\/title>/i);
  assert.match(html, /Drive a persistent Claude Code session from Codex\./);
  assert.match(html, /https:\/\/github\.com\/kyooosukedn\/codex-claude-bridge/);
  assert.match(html, /ccb send --session worker/);
  assert.match(html, /ccb steer --session worker/);
  assert.match(html, /ccb inspect --session worker --json/);
  assert.match(html, /npm install -g codex-claude-bridge/);
});

test("does not ship starter preview artifacts", async () => {
  const response = await render();
  const html = await response.text();

  assert.doesNotMatch(html, /codex-preview/i);
  assert.doesNotMatch(html, /react-loading-skeleton/i);
  assert.doesNotMatch(html, /Your site is taking shape/i);
  assert.doesNotMatch(html, /SkeletonPreview/i);
});
