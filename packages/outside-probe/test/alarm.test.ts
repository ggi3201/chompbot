import assert from "node:assert/strict";
import { test } from "node:test";
import { HEALTHY, parseState, trackChomp, type AlarmState, type Notify, type StateStore } from "../src/alarm.ts";
import type { Outcome } from "../src/types.ts";

const FAIL: Outcome = { ok: false, error: "HTTP 502" };
const PASS: Outcome = { ok: true };
const MINUTE = 60_000;

interface Harness {
  state: AlarmState;
  saves: AlarmState[];
  messages: string[];
  deliver: boolean;
  run(outcome: Outcome, minute: number): Promise<void>;
}

function harness(initial: AlarmState = HEALTHY, deliver = true): Harness {
  const h: Harness = {
    state: initial,
    saves: [],
    messages: [],
    deliver,
    run: (outcome, minute) => trackChomp(store, outcome, minute * MINUTE, notify),
  };
  const store: StateStore = {
    load: async () => h.state,
    save: async (state) => {
      h.saves.push(state);
      h.state = state;
    },
  };
  const notify: Notify = async (text) => {
    h.messages.push(text);
    return h.deliver;
  };
  return h;
}

test("while healthy it never writes and never messages", async () => {
  const h = harness();
  for (let minute = 0; minute < 100; minute++) await h.run(PASS, minute);
  assert.equal(h.saves.length, 0);
  assert.equal(h.messages.length, 0);
});

test("it sends one alarm on the third failure in a row, with the last error", async () => {
  const h = harness();
  await h.run(FAIL, 1);
  await h.run(FAIL, 2);
  assert.equal(h.messages.length, 0);
  await h.run({ ok: false, error: "timeout" }, 3);

  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /^Chomp has not answered for 3 minutes\. Monitoring is blind until it is back\./);
  assert.match(h.messages[0], /Last error: timeout/);
  assert.equal(h.state.alarmed, true);
  assert.equal(h.saves.length, 3);

  // A long outage sends no second alarm and writes nothing more.
  for (let minute = 4; minute <= 1000; minute++) await h.run(FAIL, minute);
  assert.equal(h.messages.length, 1);
  assert.equal(h.saves.length, 3);
});

test("a success after one or two failures resets the count without a message", async () => {
  const h = harness();
  await h.run(FAIL, 1);
  await h.run(FAIL, 2);
  await h.run(PASS, 3);
  assert.deepEqual(h.state, HEALTHY);
  assert.equal(h.messages.length, 0);
  await h.run(FAIL, 4);
  await h.run(FAIL, 5);
  assert.equal(h.messages.length, 0);
});

test("recovery sends one message with the outage length, then goes quiet", async () => {
  const h = harness();
  for (let minute = 10; minute <= 12; minute++) await h.run(FAIL, minute);
  await h.run(PASS, 17);
  await h.run(PASS, 18);

  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1], "Chomp is back after 7 min.");
  assert.deepEqual(h.state, HEALTHY);
  assert.equal(h.saves.length, 4);
});

test("an alarm that could not be delivered is tried again on the next failure, without extra writes", async () => {
  const h = harness(HEALTHY, false);
  for (let minute = 1; minute <= 5; minute++) await h.run(FAIL, minute);
  assert.equal(h.messages.length, 3);
  assert.equal(h.state.alarmed, false);
  assert.equal(h.saves.length, 3);

  h.deliver = true;
  await h.run(FAIL, 6);
  assert.equal(h.state.alarmed, true);
  await h.run(FAIL, 7);
  assert.equal(h.messages.length, 4);
});

test("a recovery message that could not be delivered is tried again", async () => {
  const h = harness({ failures: 3, since: 0, alarmed: true }, false);
  await h.run(PASS, 4);
  assert.equal(h.state.alarmed, true);
  assert.equal(h.saves.length, 0);
  h.deliver = true;
  await h.run(PASS, 5);
  assert.deepEqual(h.state, HEALTHY);
  assert.equal(h.messages.at(-1), "Chomp is back after 5 min.");
});

test("a stored state that is missing or damaged counts as healthy", () => {
  assert.deepEqual(parseState(null), HEALTHY);
  assert.deepEqual(parseState("{"), HEALTHY);
  assert.deepEqual(parseState('{"failures":"x"}'), HEALTHY);
  assert.deepEqual(parseState('{"failures":2,"since":5,"alarmed":false}'), { failures: 2, since: 5, alarmed: false });
});
