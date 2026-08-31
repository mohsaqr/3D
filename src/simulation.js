export const BASELINE_VITALS = Object.freeze({
  heart_rate: 116,
  oxygen_saturation: 86,
  respiratory_rate: 30,
  systolic: 168,
  diastolic: 94,
  temperature: 37.8,
});

export const ACTION_DEFINITIONS = Object.freeze({
  introduce: {
    label: "Talk to patient",
    short_label: "Talk",
    category: "assess",
    icon: "chat",
    points: 5,
    duration: 1,
    feedback: "Daniel can speak in short sentences and reports worsening breathlessness.",
  },
  observe_breathing: {
    label: "Observe breathing",
    short_label: "Observe",
    category: "assess",
    icon: "eye",
    points: 10,
    duration: 2,
    feedback: "Accessory muscle use and a prolonged expiratory phase are visible.",
  },
  auscultate: {
    label: "Auscultate lungs",
    short_label: "Lung sounds",
    category: "assess",
    icon: "stethoscope",
    points: 10,
    duration: 3,
    feedback: "Widespread expiratory wheeze with reduced air entry at both bases.",
  },
  attach_monitor: {
    label: "Attach monitoring",
    short_label: "Monitor",
    category: "investigate",
    icon: "monitor",
    points: 10,
    duration: 2,
    feedback: "Continuous ECG, blood pressure, and oxygen saturation are connected.",
  },
  check_chart: {
    label: "Review clinical chart",
    short_label: "Chart",
    category: "investigate",
    icon: "chart",
    points: 5,
    duration: 2,
    feedback: "History: obstructive airways disease. No recorded medication allergy.",
  },
  position_upright: {
    label: "Sit patient upright",
    short_label: "Position",
    category: "treat",
    icon: "bed",
    points: 15,
    duration: 3,
    feedback: "Daniel is repositioned upright and his work of breathing begins to ease.",
  },
  apply_oxygen: {
    label: "Apply controlled oxygen",
    short_label: "Oxygen",
    category: "treat",
    icon: "oxygen",
    points: 20,
    duration: 4,
    feedback: "Controlled oxygen is applied. Saturation is responding gradually.",
  },
  bronchodilator: {
    label: "Give bronchodilator",
    short_label: "Bronchodilator",
    category: "treat",
    icon: "lungs",
    points: 20,
    duration: 6,
    feedback: "Bronchodilator therapy is started. Air entry and respiratory rate improve.",
  },
  call_team: {
    label: "Escalate clinical care",
    short_label: "Escalate",
    category: "treat",
    icon: "alert",
    points: 15,
    duration: 2,
    feedback: "The senior clinical team is on the way. A structured handover is prepared.",
  },
  fluid_bolus: {
    label: "Give rapid fluid bolus",
    short_label: "Fluid bolus",
    category: "treat",
    icon: "drop",
    points: -10,
    duration: 4,
    unsafe: true,
    feedback: "The unindicated bolus increases respiratory discomfort. Reassess your plan.",
  },
});

const TARGET_EFFECTS = Object.freeze({
  position_upright: {
    oxygen_saturation: 1,
    respiratory_rate: -2,
    heart_rate: -2,
  },
  apply_oxygen: {
    oxygen_saturation: 6,
    respiratory_rate: -3,
    heart_rate: -4,
  },
  bronchodilator: {
    oxygen_saturation: 4,
    respiratory_rate: -7,
    heart_rate: -12,
  },
  call_team: {
    heart_rate: -2,
  },
  fluid_bolus: {
    oxygen_saturation: -3,
    respiratory_rate: 3,
    systolic: 6,
  },
});

const OBJECTIVES = Object.freeze([
  {
    id: "assess",
    label: "Complete a focused breathing assessment",
    action_ids: ["observe_breathing", "auscultate"],
  },
  {
    id: "monitor",
    label: "Establish continuous monitoring",
    action_ids: ["attach_monitor"],
  },
  {
    id: "oxygenation",
    label: "Support oxygenation and positioning",
    action_ids: ["position_upright", "apply_oxygen"],
  },
  {
    id: "escalate",
    label: "Escalate and begin targeted treatment",
    action_ids: ["bronchodilator", "call_team"],
  },
]);

/**
 * Create a new deterministic clinical scenario state.
 * @param {Partial<ReturnType<typeof createSimulation>>} [overrides] Initial values to override.
 * @return {object} A fresh serializable simulation state.
 * @example
 * const state = createSimulation();
 */
export function createSimulation(overrides = {}) {
  const state = {
    elapsed_seconds: 0,
    score: 0,
    actions: [],
    log: [],
    status: "critical",
    running: false,
    completed: false,
    ...overrides,
  };

  return {
    ...state,
    actions: [...state.actions],
    log: [...state.log],
  };
}

/**
 * Calculate current vitals from elapsed time and completed actions.
 * @param {ReturnType<typeof createSimulation>} state Simulation state.
 * @return {typeof BASELINE_VITALS} Current vital values.
 * @example
 * deriveVitals(createSimulation());
 */
export function deriveVitals(state) {
  validateState(state);
  const action_effects = state.actions
    .map((action_id) => TARGET_EFFECTS[action_id])
    .filter(Boolean);
  const untreated_deterioration = Math.min(state.elapsed_seconds / 90, 1);
  const has_support = state.actions.includes("apply_oxygen");
  const deterioration_multiplier = has_support ? 0 : untreated_deterioration;
  const effect_totals = Object.keys(BASELINE_VITALS).reduce((totals, vital_name) => {
    totals[vital_name] = action_effects.reduce(
      (sum, effect) => sum + (effect[vital_name] ?? 0),
      0,
    );
    return totals;
  }, {});

  return {
    heart_rate: clamp(
      Math.round(BASELINE_VITALS.heart_rate + effect_totals.heart_rate + deterioration_multiplier * 5),
      40,
      180,
    ),
    oxygen_saturation: clamp(
      Math.round(
        BASELINE_VITALS.oxygen_saturation
          + effect_totals.oxygen_saturation
          - deterioration_multiplier * 3,
      ),
      60,
      100,
    ),
    respiratory_rate: clamp(
      Math.round(
        BASELINE_VITALS.respiratory_rate
          + effect_totals.respiratory_rate
          + deterioration_multiplier * 3,
      ),
      6,
      50,
    ),
    systolic: clamp(
      Math.round(BASELINE_VITALS.systolic + effect_totals.systolic),
      70,
      220,
    ),
    diastolic: BASELINE_VITALS.diastolic,
    temperature: BASELINE_VITALS.temperature,
  };
}

/**
 * Apply one clinical action and return a new state.
 * @param {ReturnType<typeof createSimulation>} state Simulation state.
 * @param {keyof typeof ACTION_DEFINITIONS} action_id Action identifier.
 * @return {{state: object, event: object, duplicate: boolean}} Transition result.
 * @example
 * applyClinicalAction(createSimulation(), "attach_monitor");
 */
export function applyClinicalAction(state, action_id) {
  validateState(state);
  const action = ACTION_DEFINITIONS[action_id];
  if (!action) {
    throw new Error(`Unknown clinical action: ${action_id}`);
  }

  const duplicate = state.actions.includes(action_id);
  const event = createLogEntry(
    state.elapsed_seconds,
    duplicate ? `${action.label} already completed.` : action.feedback,
    action.unsafe ? "warning" : "action",
    action_id,
  );
  if (duplicate) {
    return { state: { ...state, log: [...state.log, event] }, event, duplicate };
  }

  const next_state = {
    ...state,
    actions: [...state.actions, action_id],
    score: Math.max(0, state.score + action.points),
    elapsed_seconds: state.elapsed_seconds + action.duration,
    log: [...state.log, event],
  };
  const status = derivePatientStatus(deriveVitals(next_state), next_state.actions);
  const objectives = deriveObjectives(next_state.actions);

  return {
    state: {
      ...next_state,
      status,
      completed: objectives.every((objective) => objective.complete),
    },
    event,
    duplicate,
  };
}

/**
 * Advance scenario time without mutating the input state.
 * @param {ReturnType<typeof createSimulation>} state Simulation state.
 * @param {number} delta_seconds Non-negative elapsed seconds.
 * @return {object} Updated state.
 * @example
 * tickSimulation(createSimulation(), 1);
 */
export function tickSimulation(state, delta_seconds) {
  validateState(state);
  if (!Number.isFinite(delta_seconds) || delta_seconds < 0) {
    throw new Error("delta_seconds must be a non-negative finite number.");
  }
  if (!state.running || state.completed) {
    return { ...state };
  }

  const next_state = {
    ...state,
    elapsed_seconds: state.elapsed_seconds + delta_seconds,
  };
  return {
    ...next_state,
    status: derivePatientStatus(deriveVitals(next_state), next_state.actions),
  };
}

/**
 * Derive a human-readable patient status.
 * @param {typeof BASELINE_VITALS} vitals Current vital values.
 * @param {string[]} actions Completed action ids.
 * @return {"critical"|"unstable"|"stabilizing"|"stable"} Patient state label.
 * @example
 * derivePatientStatus(BASELINE_VITALS, []);
 */
export function derivePatientStatus(vitals, actions) {
  validateVitals(vitals);
  if (vitals.oxygen_saturation < 88 || vitals.respiratory_rate > 32) {
    return "critical";
  }
  if (vitals.oxygen_saturation < 92 || vitals.respiratory_rate > 26) {
    return "unstable";
  }
  if (vitals.oxygen_saturation < 95 || !actions.includes("call_team")) {
    return "stabilizing";
  }
  return "stable";
}

/**
 * Calculate objective completion from the action history.
 * @param {string[]} actions Completed action ids.
 * @return {Array<{id: string, label: string, complete: boolean}>} Objective states.
 * @example
 * deriveObjectives(["attach_monitor"]);
 */
export function deriveObjectives(actions) {
  if (!Array.isArray(actions)) {
    throw new Error("actions must be an array.");
  }
  return OBJECTIVES.map((objective) => ({
    id: objective.id,
    label: objective.label,
    complete: objective.action_ids.every((action_id) => actions.includes(action_id)),
  }));
}

/**
 * Reconstruct vital-sign history by replaying logged actions over scenario time.
 * @param {ReturnType<typeof createSimulation>} state Simulation state.
 * @param {{samples?: number}} [options] Sampling configuration.
 * @return {Array<typeof BASELINE_VITALS & {time: number}>} One row per sample,
 *   ordered by time from scenario start to the current moment.
 * @example
 * deriveVitalTrends(createSimulation(), { samples: 6 });
 */
export function deriveVitalTrends(state, options = {}) {
  validateState(state);
  const samples = options.samples ?? 13;
  if (!Number.isInteger(samples) || samples < 2) {
    throw new Error("options.samples must be an integer of at least 2.");
  }

  const action_start_times = state.actions.map((action_id) => ({
    action_id,
    time: state.log.find((event) => event.action_id === action_id)?.time ?? 0,
  }));

  return Array.from({ length: samples }, (_, sample_index) => {
    const time = (state.elapsed_seconds * sample_index) / (samples - 1);
    const applied_actions = action_start_times
      .filter((entry) => entry.time <= time)
      .map((entry) => entry.action_id);
    const vitals = deriveVitals({
      ...state,
      elapsed_seconds: time,
      actions: applied_actions,
    });
    return { time: Math.round(time), ...vitals };
  });
}

/**
 * Group actions for the action tray.
 * @return {Record<string, Array<object>>} Action definitions grouped by category.
 * @example
 * groupActions();
 */
export function groupActions() {
  return Object.entries(ACTION_DEFINITIONS).reduce((groups, [id, definition]) => {
    groups[definition.category] ??= [];
    groups[definition.category].push({ id, ...definition });
    return groups;
  }, {});
}

/**
 * Create a timeline entry.
 * @param {number} elapsed_seconds Scenario time.
 * @param {string} message Event description.
 * @param {string} type Event severity/type.
 * @param {string|null} [action_id] Optional originating action.
 * @return {{time: number, message: string, type: string, action_id: string|null}} Log item.
 * @example
 * createLogEntry(0, "Case started", "system");
 */
export function createLogEntry(elapsed_seconds, message, type, action_id = null) {
  if (!Number.isFinite(elapsed_seconds) || elapsed_seconds < 0) {
    throw new Error("elapsed_seconds must be a non-negative finite number.");
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("message must be a non-empty string.");
  }
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("type must be a non-empty string.");
  }
  return { time: elapsed_seconds, message, type, action_id };
}

/**
 * Validate a simulation state.
 * @param {object} state Candidate state.
 * @return {true} True when valid.
 * @example
 * validateState(createSimulation());
 */
export function validateState(state) {
  if (!state || typeof state !== "object") {
    throw new Error("state must be an object.");
  }
  if (!Number.isFinite(state.elapsed_seconds) || state.elapsed_seconds < 0) {
    throw new Error("state.elapsed_seconds must be a non-negative finite number.");
  }
  if (!Array.isArray(state.actions) || !Array.isArray(state.log)) {
    throw new Error("state actions and log must be arrays.");
  }
  return true;
}

/**
 * Validate the numeric vital-sign structure.
 * @param {object} vitals Candidate vital signs.
 * @return {true} True when valid.
 * @example
 * validateVitals(BASELINE_VITALS);
 */
export function validateVitals(vitals) {
  const required_vitals = Object.keys(BASELINE_VITALS);
  if (!vitals || typeof vitals !== "object") {
    throw new Error("vitals must be an object.");
  }
  const invalid_vital = required_vitals.find(
    (vital_name) => !Number.isFinite(vitals[vital_name]),
  );
  if (invalid_vital) {
    throw new Error(`vitals.${invalid_vital} must be numeric.`);
  }
  return true;
}

/**
 * Clamp a number to an inclusive range.
 * @param {number} value Number to limit.
 * @param {number} minimum Lower bound.
 * @param {number} maximum Upper bound.
 * @return {number} Clamped number.
 * @example
 * clamp(12, 0, 10);
 */
export function clamp(value, minimum, maximum) {
  if (![value, minimum, maximum].every(Number.isFinite) || minimum > maximum) {
    throw new Error("clamp requires finite numbers and minimum <= maximum.");
  }
  return Math.min(Math.max(value, minimum), maximum);
}
