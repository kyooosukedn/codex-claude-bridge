import assert from "node:assert/strict";
import test from "node:test";

import {
  executeCoordinatedSlash,
  executeSend,
  executeSteer,
} from "../bin/codex-claude-bridge.mjs";

function fakeCoordinator(events) {
  return async ({
    captureBaseline,
    inject,
    observeInjection,
    commandClass,
    commandId = "command-1",
  }) => {
    events.push(`${commandClass}:acquire`);
    let payload;
    try {
      const baseline = await captureBaseline();
      events.push(`${commandClass}:inject`);
      payload = await inject({ baseline });
      const observed = await observeInjection({ baseline, payload });
      if (!observed.observed) throw new Error("not observed");
    } catch (error) {
      events.push(`${commandClass}:release`);
      return {
        ack: "uncertain",
        commandClass,
        commandId,
        reason: error.message,
        attempts: 1,
      };
    }
    events.push(`${commandClass}:release`);
    return {
      ack: "injected",
      commandClass,
      commandId,
      payload,
      attempts: 1,
      states: ["queued", "injecting", "acknowledged", "released"],
    };
  };
}

test("send waits for terminal only after injection coordinator releases", async () => {
  const events = [];
  const result = await executeSend({
    session: "alpha",
    prompt: "work",
    deps: {
      coordinateInjection: fakeCoordinator(events),
      capture: () => "idle",
      send: () => {
        events.push("ccmux:send");
        return JSON.stringify({
          id: "job-1",
          session: "alpha",
          status: "sent",
          sentAt: "2026-07-25T12:00:00.000Z",
        });
      },
      observe: async () => ({ observed: true, reason: "thinking" }),
      waitJob: (id) => {
        events.push(`ccmux:wait:${id}`);
        return JSON.stringify({ id, session: "alpha", status: "done" });
      },
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(events, [
    "prompt:acquire",
    "prompt:inject",
    "ccmux:send",
    "prompt:release",
    "ccmux:wait:job-1",
  ]);
});

test("malformed send acknowledgment is uncertain and never waits", async () => {
  const events = [];
  const result = await executeSend({
    session: "alpha",
    prompt: "work",
    deps: {
      coordinateInjection: fakeCoordinator(events),
      capture: () => "idle",
      send: () => "{broken",
      observe: async () => ({ observed: true }),
      waitJob: () => {
        throw new Error("wait must not run");
      },
      now: () => new Date(),
    },
  });

  assert.equal(result.exitCode, 9);
  assert.equal(result.body.ack, "uncertain");
  assert.equal(events.filter((event) => event === "prompt:inject").length, 1);
});

test("send transport failure is uncertain and never retries or waits", async () => {
  const events = [];
  const result = await executeSend({
    session: "alpha",
    prompt: "work",
    deps: {
      coordinateInjection: fakeCoordinator(events),
      capture: () => "idle",
      send: () => {
        events.push("ccmux:send");
        throw new Error("subprocess exited 1");
      },
      observe: async () => {
        throw new Error("must not observe after transport failure");
      },
      waitJob: () => {
        throw new Error("must not wait after transport failure");
      },
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    },
  });

  assert.equal(result.exitCode, 9);
  assert.equal(result.body.ack, "uncertain");
  assert.equal(events.filter((event) => event === "ccmux:send").length, 1);
});

test("send wait failure stays post-lock and exits uncertain", async () => {
  const events = [];
  const result = await executeSend({
    session: "alpha",
    prompt: "work",
    deps: {
      coordinateInjection: fakeCoordinator(events),
      capture: () => "idle",
      send: () =>
        JSON.stringify({
          id: "job-1",
          session: "alpha",
          status: "sent",
          sentAt: "2026-07-25T12:00:00.000Z",
        }),
      observe: async () => ({ observed: true, reason: "thinking" }),
      waitJob: () => {
        events.push("ccmux:wait");
        throw new Error("wait subprocess failed");
      },
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    },
  });

  assert.equal(result.exitCode, 9);
  assert.equal(result.body.coordinator.ack, "injected");
  assert.equal(result.body.terminal.status, "unknown");
  assert.equal(result.body.terminal.reason, "wait-error");
  assert.ok(
    events.indexOf("prompt:release") < events.indexOf("ccmux:wait"),
    "terminal wait must remain outside the lock",
  );
});

test("coordinated slash keeps lock through readiness barrier and preserves telemetry", async () => {
  const events = [];
  let nowCall = 0;
  const result = await executeCoordinatedSlash({
    session: "alpha",
    text: "/plan",
    opts: { "ready-timeout-ms": "1234" },
    deps: {
      coordinateInjection: fakeCoordinator(events),
      capture: () => "idle-before",
      enterText: () => {
        events.push("tmux:enter");
        return { session: "alpha", entered: true, bytes: 5 };
      },
      modeReadyBarrier: async (session, baseline, timeoutMs, intervalMs) => {
        events.push("slash:barrier");
        assert.equal(session, "alpha");
        assert.equal(baseline, "idle-before");
        assert.equal(timeoutMs, 1234);
        assert.equal(intervalMs, 1000);
        return {
          ready: true,
          state: "idle",
          reason: "fresh-ready",
          waitedMs: 100,
          attempts: 2,
          evidence: { footer: true },
        };
      },
      now: () =>
        new Date(`2026-07-25T12:00:0${nowCall++}.000Z`),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.body.command, "/plan");
  assert.equal(result.body.commandId, result.body.coordinator.commandId);
  assert.ok(result.body.injectedAt);
  assert.ok(result.body.readiness.readyAt);
  assert.deepEqual(events, [
    "mode-changing:acquire",
    "mode-changing:inject",
    "tmux:enter",
    "slash:barrier",
    "mode-changing:release",
  ]);
});

test("coordinated slash baseline failure remains fail-closed", async () => {
  const events = [];
  const coordinateInjection = async ({
    captureBaseline,
    commandClass,
    commandId,
  }) => {
    events.push(`${commandClass}:acquire`);
    try {
      await captureBaseline();
    } catch (error) {
      events.push(`${commandClass}:release`);
      return {
        ack: "not-injected",
        commandClass,
        commandId,
        reason: "baseline-error",
        error: error.message,
      };
    }
    throw new Error("expected baseline failure");
  };

  const result = await executeCoordinatedSlash({
    session: "alpha",
    text: "/plan",
    opts: {},
    deps: {
      coordinateInjection,
      capture: () => {
        throw new Error("capture failed");
      },
      enterText: () => {
        throw new Error("must not inject");
      },
      modeReadyBarrier: async () => {
        throw new Error("must not wait");
      },
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    },
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.body.readiness.reason, "baseline-capture-failed");
  assert.equal(result.body.injectedAt, undefined);
  assert.deepEqual(events, [
    "mode-changing:acquire",
    "mode-changing:release",
  ]);
});

test("coordinator outcomes map not-injected to 7 and uncertain to 9", async () => {
  const notInjected = async ({ commandId, commandClass, session }) => ({
    ack: "not-injected",
    commandId,
    commandClass,
    session,
    reason: "baseline-error",
  });
  const uncertain = async ({ commandId, commandClass, session }) => ({
    ack: "uncertain",
    commandId,
    commandClass,
    session,
    reason: "release-failed",
  });

  const sendResult = await executeSend({
    session: "alpha",
    prompt: "work",
    deps: { coordinateInjection: notInjected },
  });
  const steerResult = await executeSteer({
    session: "alpha",
    message: "redirect",
    deps: { coordinateInjection: notInjected },
  });
  const slashResult = await executeCoordinatedSlash({
    session: "alpha",
    text: "/plan",
    opts: {},
    deps: {
      coordinateInjection: uncertain,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    },
  });

  assert.equal(sendResult.exitCode, 7);
  assert.equal(steerResult.exitCode, 7);
  assert.equal(slashResult.exitCode, 9);
});

test("steer uses the same coordinator without terminal wait", async () => {
  const events = [];
  const result = await executeSteer({
    session: "alpha",
    message: "narrow scope",
    deps: {
      coordinateInjection: fakeCoordinator(events),
      capture: () => "thinking",
      steerMessage: () => {
        events.push("ccmux:steer");
        return { status: "sent" };
      },
      now: () => new Date(),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(events, [
    "steer:acquire",
    "steer:inject",
    "ccmux:steer",
    "steer:release",
  ]);
});
