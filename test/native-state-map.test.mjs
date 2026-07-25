// test/native-state-map.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapNativeState } from "../lib/native/state-map.mjs";

test("idle -> idle", () => {
  assert.equal(mapNativeState({ status: "idle" }), "idle");
});

test("working -> thinking", () => {
  assert.equal(mapNativeState({ status: "working" }), "thinking");
});

test("done -> done", () => {
  assert.equal(mapNativeState({ status: "done" }), "done");
});

test("failed -> crashed", () => {
  assert.equal(mapNativeState({ status: "failed" }), "crashed");
});

test("stopped -> stopped", () => {
  assert.equal(mapNativeState({ status: "stopped" }), "stopped");
});

test("blocked + waitingFor permission -> permission_prompt", () => {
  assert.equal(
    mapNativeState({ status: "blocked", waitingFor: "permission" }),
    "permission_prompt",
  );
});

test("blocked + waitingFor input -> needs_input", () => {
  assert.equal(mapNativeState({ status: "blocked", waitingFor: "input" }), "needs_input");
});

test("blocked + waitingFor sandbox -> needs_input", () => {
  assert.equal(mapNativeState({ status: "blocked", waitingFor: "sandbox" }), "needs_input");
});

test("blocked + waitingFor dialog -> needs_input", () => {
  assert.equal(mapNativeState({ status: "blocked", waitingFor: "dialog" }), "needs_input");
});

test("blocked + unknown waitingFor -> unknown", () => {
  assert.equal(mapNativeState({ status: "blocked", waitingFor: "something_new" }), "unknown");
});

test("lifecycle state takes precedence over secondary status", () => {
  assert.equal(mapNativeState({ state: "blocked", status: "idle" }), "unknown");
});

test("lifecycle blocked plus waitingFor permission maps to permission_prompt", () => {
  assert.equal(
    mapNativeState({ state: "blocked", status: "idle", waitingFor: "permission" }),
    "permission_prompt",
  );
});

test("lifecycle stopped maps to stopped", () => {
  assert.equal(mapNativeState({ state: "stopped" }), "stopped");
});

test("null agent -> unknown", () => {
  assert.equal(mapNativeState(null), "unknown");
});

test("unknown status -> unknown", () => {
  assert.equal(mapNativeState({ status: "invented" }), "unknown");
});
