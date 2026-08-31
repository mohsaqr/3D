import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_DEFINITIONS,
  BASELINE_VITALS,
  applyClinicalAction,
  clamp,
  createLogEntry,
  createSimulation,
  deriveObjectives,
  derivePatientStatus,
  deriveVitals,
  groupActions,
  tickSimulation,
  validateState,
  validateVitals,
} from "../src/simulation.js";

const REQUIRED_ACTIONS = [
  "observe_breathing",
  "auscultate",
  "attach_monitor",
  "position_upright",
  "apply_oxygen",
  "bronchodilator",
  "call_team",
];

test("createSimulation returns the documented baseline state", () => {
  const state = createSimulation();

  assert.deepEqual(state, {
    elapsed_seconds: 0,
    score: 0,
    actions: [],
    log: [],
    status: "critical",
    running: false,
    completed: false,
  });
  assert.deepEqual(deriveVitals(state), BASELINE_VITALS);
});

test("createSimulation applies overrides and copies caller-owned arrays", () => {
  const actions = ["introduce"];
  const log = [createLogEntry(0, "Started", "system")];
  const state = createSimulation({
    elapsed_seconds: 12,
    score: 5,
    actions,
    log,
    running: true,
  });

  assert.equal(state.elapsed_seconds, 12);
  assert.equal(state.score, 5);
  assert.equal(state.running, true);
  assert.deepEqual(state.actions, actions);
  assert.deepEqual(state.log, log);
  assert.notStrictEqual(state.actions, actions);
  assert.notStrictEqual(state.log, log);

  actions.push("attach_monitor");
  log.push(createLogEntry(1, "Changed", "system"));
  assert.deepEqual(state.actions, ["introduce"]);
  assert.equal(state.log.length, 1);
});

test("deriveVitals applies each targeted treatment effect additively", () => {
  const state = createSimulation({
    actions: [
      "position_upright",
      "apply_oxygen",
      "bronchodilator",
      "call_team",
    ],
  });

  assert.deepEqual(deriveVitals(state), {
    heart_rate: 96,
    oxygen_saturation: 97,
    respiratory_rate: 18,
    systolic: 168,
    diastolic: 94,
    temperature: 37.8,
  });
});

test("deriveVitals ignores assessment actions with no physiological effect", () => {
  const state = createSimulation({
    actions: ["introduce", "observe_breathing", "auscultate", "check_chart"],
  });

  assert.deepEqual(deriveVitals(state), BASELINE_VITALS);
});

test("untreated deterioration increases linearly and caps at 90 seconds", () => {
  assert.deepEqual(deriveVitals(createSimulation({ elapsed_seconds: 45 })), {
    heart_rate: 119,
    oxygen_saturation: 85,
    respiratory_rate: 32,
    systolic: 168,
    diastolic: 94,
    temperature: 37.8,
  });

  const at_cap = deriveVitals(createSimulation({ elapsed_seconds: 90 }));
  const after_cap = deriveVitals(createSimulation({ elapsed_seconds: 900 }));
  assert.deepEqual(at_cap, {
    heart_rate: 121,
    oxygen_saturation: 83,
    respiratory_rate: 33,
    systolic: 168,
    diastolic: 94,
    temperature: 37.8,
  });
  assert.deepEqual(after_cap, at_cap);
});

test("controlled oxygen suppresses time-based deterioration", () => {
  const immediate = deriveVitals(
    createSimulation({ actions: ["apply_oxygen"] }),
  );
  const delayed = deriveVitals(
    createSimulation({ elapsed_seconds: 900, actions: ["apply_oxygen"] }),
  );

  assert.deepEqual(delayed, immediate);
  assert.deepEqual(delayed, {
    heart_rate: 112,
    oxygen_saturation: 92,
    respiratory_rate: 27,
    systolic: 168,
    diastolic: 94,
    temperature: 37.8,
  });
});

test("unsafe fluid bolus worsens respiratory vitals and raises systolic pressure", () => {
  const state = createSimulation({ actions: ["fluid_bolus"] });

  assert.deepEqual(deriveVitals(state), {
    heart_rate: 116,
    oxygen_saturation: 83,
    respiratory_rate: 33,
    systolic: 174,
    diastolic: 94,
    temperature: 37.8,
  });
});

test("deriveVitals counts repeated action ids in a synthetic state", () => {
  const state = createSimulation({
    actions: ["apply_oxygen", "apply_oxygen"],
  });

  assert.deepEqual(deriveVitals(state), {
    heart_rate: 108,
    oxygen_saturation: 98,
    respiratory_rate: 24,
    systolic: 168,
    diastolic: 94,
    temperature: 37.8,
  });
});

test("applyClinicalAction performs an immutable scored transition", () => {
  const original = createSimulation({ running: true });
  const result = applyClinicalAction(original, "attach_monitor");

  assert.equal(result.duplicate, false);
  assert.deepEqual(original, createSimulation({ running: true }));
  assert.deepEqual(result.state.actions, ["attach_monitor"]);
  assert.equal(result.state.score, 10);
  assert.equal(result.state.elapsed_seconds, 2);
  assert.equal(result.state.running, true);
  assert.equal(result.state.completed, false);
  assert.equal(result.state.status, "critical");
  assert.deepEqual(result.event, {
    time: 0,
    message:
      "Continuous ECG, blood pressure, and oxygen saturation are connected.",
    type: "action",
    action_id: "attach_monitor",
  });
  assert.deepEqual(result.state.log, [result.event]);
  assert.notStrictEqual(result.state.actions, original.actions);
  assert.notStrictEqual(result.state.log, original.log);
});

test("applyClinicalAction floors a negative score and records unsafe actions as warnings", () => {
  const result = applyClinicalAction(
    createSimulation({ score: 4, elapsed_seconds: 8 }),
    "fluid_bolus",
  );

  assert.equal(result.state.score, 0);
  assert.equal(result.state.elapsed_seconds, 12);
  assert.equal(result.event.time, 8);
  assert.equal(result.event.type, "warning");
  assert.equal(result.event.action_id, "fluid_bolus");
  assert.match(result.event.message, /increases respiratory discomfort/i);
});

test("applyClinicalAction rejects unknown action ids", () => {
  assert.throws(
    () => applyClinicalAction(createSimulation(), "not_an_action"),
    /Unknown clinical action: not_an_action/,
  );
});

test("a duplicate action only appends an informational action event", () => {
  const first = applyClinicalAction(createSimulation(), "apply_oxygen").state;
  const result = applyClinicalAction(first, "apply_oxygen");

  assert.equal(result.duplicate, true);
  assert.deepEqual(result.state.actions, ["apply_oxygen"]);
  assert.equal(result.state.score, first.score);
  assert.equal(result.state.elapsed_seconds, first.elapsed_seconds);
  assert.equal(result.state.status, first.status);
  assert.equal(result.state.completed, first.completed);
  assert.equal(result.state.log.length, 2);
  assert.deepEqual(result.event, {
    time: first.elapsed_seconds,
    message: "Apply controlled oxygen already completed.",
    type: "action",
    action_id: "apply_oxygen",
  });
  assert.deepEqual(result.state.log.at(-1), result.event);
  assert.notStrictEqual(result.state.log, first.log);
});

test("all required actions complete every objective and stabilize the patient", () => {
  const final_state = REQUIRED_ACTIONS.reduce(
    (state, action_id) => applyClinicalAction(state, action_id).state,
    createSimulation(),
  );

  assert.equal(final_state.completed, true);
  assert.equal(final_state.status, "stable");
  assert.equal(final_state.score, 100);
  assert.equal(final_state.elapsed_seconds, 22);
  assert.equal(final_state.log.length, REQUIRED_ACTIONS.length);
  assert.ok(deriveObjectives(final_state.actions).every(({ complete }) => complete));
  assert.deepEqual(deriveVitals(final_state), {
    heart_rate: 96,
    oxygen_saturation: 97,
    respiratory_rate: 18,
    systolic: 168,
    diastolic: 94,
    temperature: 37.8,
  });
});

test("completion remains false until the final required action", () => {
  const almost_complete = REQUIRED_ACTIONS.slice(0, -1).reduce(
    (state, action_id) => applyClinicalAction(state, action_id).state,
    createSimulation(),
  );

  assert.equal(almost_complete.completed, false);
  assert.equal(
    deriveObjectives(almost_complete.actions).find(({ id }) => id === "escalate")
      .complete,
    false,
  );

  const completed = applyClinicalAction(almost_complete, "call_team").state;
  assert.equal(completed.completed, true);
});

test("optional actions alone cannot complete the scenario", () => {
  const state = ["introduce", "check_chart"].reduce(
    (current, action_id) => applyClinicalAction(current, action_id).state,
    createSimulation(),
  );

  assert.equal(state.completed, false);
  assert.ok(deriveObjectives(state.actions).every(({ complete }) => !complete));
});

test("tickSimulation advances a running incomplete scenario without mutation", () => {
  const original = createSimulation({ running: true, elapsed_seconds: 30 });
  const next = tickSimulation(original, 60);

  assert.equal(original.elapsed_seconds, 30);
  assert.equal(next.elapsed_seconds, 90);
  assert.equal(next.running, true);
  assert.equal(next.status, "critical");
  assert.notStrictEqual(next, original);
  assert.deepEqual(deriveVitals(next), {
    heart_rate: 121,
    oxygen_saturation: 83,
    respiratory_rate: 33,
    systolic: 168,
    diastolic: 94,
    temperature: 37.8,
  });
});

test("tickSimulation does not advance paused or completed scenarios", () => {
  const paused = createSimulation({ elapsed_seconds: 10, running: false });
  const completed = createSimulation({
    elapsed_seconds: 20,
    running: true,
    completed: true,
  });

  const paused_result = tickSimulation(paused, 5);
  const completed_result = tickSimulation(completed, 5);
  assert.deepEqual(paused_result, paused);
  assert.deepEqual(completed_result, completed);
  assert.notStrictEqual(paused_result, paused);
  assert.notStrictEqual(completed_result, completed);
});

test("tickSimulation accepts zero and rejects invalid deltas", () => {
  const state = createSimulation({ running: true });
  assert.equal(tickSimulation(state, 0).elapsed_seconds, 0);

  [-1, Number.NaN, Number.POSITIVE_INFINITY, "1", null].forEach(
    (invalid_delta) => {
      assert.throws(
        () => tickSimulation(state, invalid_delta),
        /delta_seconds must be a non-negative finite number/,
      );
    },
  );
});

test("derivePatientStatus honors critical and unstable threshold boundaries", () => {
  assert.equal(
    derivePatientStatus({ ...BASELINE_VITALS, oxygen_saturation: 87 }, []),
    "critical",
  );
  assert.equal(
    derivePatientStatus({ ...BASELINE_VITALS, oxygen_saturation: 88 }, []),
    "unstable",
  );
  assert.equal(
    derivePatientStatus(
      { ...BASELINE_VITALS, oxygen_saturation: 95, respiratory_rate: 33 },
      ["call_team"],
    ),
    "critical",
  );
  assert.equal(
    derivePatientStatus(
      { ...BASELINE_VITALS, oxygen_saturation: 95, respiratory_rate: 32 },
      ["call_team"],
    ),
    "unstable",
  );
});

test("derivePatientStatus distinguishes stabilizing from stable", () => {
  const acceptable_vitals = {
    ...BASELINE_VITALS,
    oxygen_saturation: 95,
    respiratory_rate: 26,
  };

  assert.equal(derivePatientStatus(acceptable_vitals, []), "stabilizing");
  assert.equal(
    derivePatientStatus(
      { ...acceptable_vitals, oxygen_saturation: 94 },
      ["call_team"],
    ),
    "stabilizing",
  );
  assert.equal(
    derivePatientStatus(acceptable_vitals, ["call_team"]),
    "stable",
  );
});

test("deriveObjectives reports independent objective progress in definition order", () => {
  assert.deepEqual(
    deriveObjectives([
      "observe_breathing",
      "auscultate",
      "attach_monitor",
      "unknown_action",
    ]),
    [
      {
        id: "assess",
        label: "Complete a focused breathing assessment",
        complete: true,
      },
      {
        id: "monitor",
        label: "Establish continuous monitoring",
        complete: true,
      },
      {
        id: "oxygenation",
        label: "Support oxygenation and positioning",
        complete: false,
      },
      {
        id: "escalate",
        label: "Escalate and begin targeted treatment",
        complete: false,
      },
    ],
  );
});

test("deriveObjectives tolerates duplicate action ids but requires every member", () => {
  const objectives = deriveObjectives([
    "position_upright",
    "position_upright",
    "apply_oxygen",
  ]);

  assert.equal(
    objectives.find(({ id }) => id === "oxygenation").complete,
    true,
  );
  assert.equal(objectives.filter(({ complete }) => complete).length, 1);
  assert.throws(() => deriveObjectives("apply_oxygen"), /actions must be an array/);
});

test("groupActions includes every action once under its declared category", () => {
  const groups = groupActions();
  const grouped_actions = Object.values(groups).flat();

  assert.deepEqual(Object.keys(groups), ["assess", "investigate", "treat"]);
  assert.equal(grouped_actions.length, Object.keys(ACTION_DEFINITIONS).length);
  assert.deepEqual(
    grouped_actions.map(({ id }) => id),
    Object.keys(ACTION_DEFINITIONS),
  );
  grouped_actions.forEach(({ id, category, ...definition }) => {
    assert.equal(category, ACTION_DEFINITIONS[id].category);
    assert.deepEqual({ category, ...definition }, ACTION_DEFINITIONS[id]);
  });
});

test("groupActions creates fresh collections on each call", () => {
  const first = groupActions();
  const second = groupActions();

  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.assess, second.assess);
  assert.notStrictEqual(first.assess[0], second.assess[0]);
});

test("createLogEntry creates a serializable entry with an optional action id", () => {
  assert.deepEqual(createLogEntry(1.5, "Case started", "system"), {
    time: 1.5,
    message: "Case started",
    type: "system",
    action_id: null,
  });
  assert.deepEqual(createLogEntry(0, "Oxygen", "action", "apply_oxygen"), {
    time: 0,
    message: "Oxygen",
    type: "action",
    action_id: "apply_oxygen",
  });
});

test("createLogEntry rejects invalid time, message, and type values", () => {
  [-1, Number.NaN, Number.POSITIVE_INFINITY, "0"].forEach((invalid_time) => {
    assert.throws(
      () => createLogEntry(invalid_time, "message", "system"),
      /elapsed_seconds must be a non-negative finite number/,
    );
  });
  ["", null, 7].forEach((invalid_message) => {
    assert.throws(
      () => createLogEntry(0, invalid_message, "system"),
      /message must be a non-empty string/,
    );
  });
  ["", null, 7].forEach((invalid_type) => {
    assert.throws(
      () => createLogEntry(0, "message", invalid_type),
      /type must be a non-empty string/,
    );
  });
});

test("validateState accepts a valid state and rejects malformed core fields", () => {
  assert.equal(validateState(createSimulation()), true);
  [null, undefined, "state", 3].forEach((invalid_state) => {
    assert.throws(() => validateState(invalid_state), /state must be an object/);
  });
  [-1, Number.NaN, Number.POSITIVE_INFINITY, "0"].forEach(
    (invalid_elapsed) => {
      assert.throws(
        () => validateState(createSimulation({ elapsed_seconds: invalid_elapsed })),
        /state.elapsed_seconds must be a non-negative finite number/,
      );
    },
  );
  assert.throws(
    () => validateState({ ...createSimulation(), actions: null }),
    /state actions and log must be arrays/,
  );
  assert.throws(
    () => validateState({ ...createSimulation(), log: {} }),
    /state actions and log must be arrays/,
  );
});

test("validateVitals accepts finite numeric vitals and permits extra fields", () => {
  assert.equal(validateVitals(BASELINE_VITALS), true);
  assert.equal(validateVitals({ ...BASELINE_VITALS, note: "synthetic" }), true);
});

test("validateVitals rejects absent, missing, and non-finite vital values", () => {
  assert.throws(() => validateVitals(null), /vitals must be an object/);
  assert.throws(() => validateVitals("vitals"), /vitals must be an object/);
  assert.throws(
    () => validateVitals({ ...BASELINE_VITALS, heart_rate: undefined }),
    /vitals.heart_rate must be numeric/,
  );
  assert.throws(
    () => validateVitals({ ...BASELINE_VITALS, oxygen_saturation: Number.NaN }),
    /vitals.oxygen_saturation must be numeric/,
  );
  assert.throws(
    () => validateVitals({ ...BASELINE_VITALS, temperature: "37.8" }),
    /vitals.temperature must be numeric/,
  );
});

test("clamp preserves in-range boundaries and clips values outside the range", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test("clamp rejects non-finite operands and reversed bounds", () => {
  [
    [Number.NaN, 0, 1],
    [0, Number.NEGATIVE_INFINITY, 1],
    [0, 0, Number.POSITIVE_INFINITY],
    [0, 2, 1],
  ].forEach((arguments_) => {
    assert.throws(
      () => clamp(...arguments_),
      /clamp requires finite numbers and minimum <= maximum/,
    );
  });
});
