import "./styles.css";
import {
  ACTION_DEFINITIONS,
  applyClinicalAction,
  createLogEntry,
  createSimulation,
  deriveObjectives,
  derivePatientStatus,
  deriveVitals,
  groupActions,
  tickSimulation,
} from "./simulation.js";

const PATIENT_REPLIES = Object.freeze({
  introduce: "It feels tight… I can't get enough air.",
  observe_breathing: "Breathing is easier if I stay sitting up.",
  auscultate: "I can hear that wheeze too. It's worse than usual.",
  attach_monitor: "The alarm is making me nervous.",
  check_chart: "My blue inhaler normally helps.",
  position_upright: "That's a little easier—thank you.",
  apply_oxygen: "I can take a deeper breath now.",
  bronchodilator: "The tightness is starting to lift.",
  call_team: "Okay. Please stay with me.",
  fluid_bolus: "My breathing feels heavier now.",
});

const SELECTION_ACTIONS = Object.freeze({
  patient: { category: "assess", action_id: "observe_breathing" },
  bed: { category: "treat", action_id: "position_upright" },
  monitor: { category: "investigate", action_id: "attach_monitor" },
  oxygen: { category: "treat", action_id: "apply_oxygen" },
  iv: { category: "treat", action_id: "fluid_bolus" },
  chart: { category: "investigate", action_id: "check_chart" },
});

/**
 * Format elapsed seconds as MM:SS.
 * @param {number} seconds Elapsed seconds.
 * @return {string} Clock string.
 * @example
 * formatElapsed(65);
 */
export function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("seconds must be a non-negative finite number.");
  }
  const rounded_seconds = Math.floor(seconds);
  return `${String(Math.floor(rounded_seconds / 60)).padStart(2, "0")}:${String(rounded_seconds % 60).padStart(2, "0")}`;
}

/**
 * Determine display severity for one vital sign.
 * @param {string} vital_name Supported vital key.
 * @param {number} value Vital value.
 * @return {"normal"|"warning"|"critical"} Severity class.
 * @example
 * vitalSeverity("oxygen_saturation", 86);
 */
export function vitalSeverity(vital_name, value) {
  if (typeof vital_name !== "string" || !Number.isFinite(value)) {
    throw new Error("vital_name must be a string and value must be numeric.");
  }
  const thresholds = {
    heart_rate: value > 120 || value < 45 ? "critical" : value > 100 ? "warning" : "normal",
    oxygen_saturation: value < 88 ? "critical" : value < 94 ? "warning" : "normal",
    respiratory_rate: value > 30 || value < 8 ? "critical" : value > 22 ? "warning" : "normal",
    blood_pressure: value > 180 || value < 85 ? "critical" : value > 145 ? "warning" : "normal",
    temperature: value > 39 || value < 35 ? "critical" : value > 37.5 ? "warning" : "normal",
  };
  if (!(vital_name in thresholds)) {
    throw new Error(`Unknown vital name: ${vital_name}`);
  }
  return thresholds[vital_name];
}

/**
 * Build a responsive SVG ECG-style path.
 * @param {number} heart_rate Current heart rate.
 * @param {number} width SVG width.
 * @param {number} height SVG height.
 * @param {number} phase Animation phase.
 * @return {string} SVG path data.
 * @example
 * createWavePath(116, 640, 96, 0);
 */
export function createWavePath(heart_rate, width, height, phase) {
  if (![heart_rate, width, height, phase].every(Number.isFinite) || heart_rate <= 0 || width <= 0 || height <= 0) {
    throw new Error("waveform inputs must be positive finite dimensions and heart rate.");
  }
  const baseline = height * 0.58;
  const beat_width = Math.max(34, 80 - (heart_rate - 60) * 0.25);
  const point_count = Math.ceil(width / 3) + 1;
  const points = Array.from({ length: point_count }, (_, index) => {
    const x_position = index * 3;
    const cycle_position = (x_position + phase * 30) % beat_width;
    const normalized_position = cycle_position / beat_width;
    let pulse = Math.sin(x_position * 0.06) * 1.4;
    if (normalized_position > 0.08 && normalized_position < 0.14) pulse -= height * 0.08;
    if (normalized_position >= 0.14 && normalized_position < 0.18) pulse += height * 0.22;
    if (normalized_position >= 0.18 && normalized_position < 0.23) pulse -= height * 0.48;
    if (normalized_position >= 0.23 && normalized_position < 0.29) pulse += height * 0.12;
    if (normalized_position >= 0.48 && normalized_position < 0.7) {
      pulse -= Math.sin(((normalized_position - 0.48) / 0.22) * Math.PI) * height * 0.08;
    }
    return `${index === 0 ? "M" : "L"}${x_position.toFixed(1)},${(baseline + pulse).toFixed(1)}`;
  });
  return points.join(" ");
}

/**
 * Return a concise status message for the patient.
 * @param {string} status Current status.
 * @return {string} Status explanation.
 * @example
 * getStatusCopy("critical");
 */
export function getStatusCopy(status) {
  const messages = {
    critical: "Immediate support required",
    unstable: "Response remains time-sensitive",
    stabilizing: "Physiology is responding",
    stable: "Immediate threat controlled",
  };
  if (!messages[status]) {
    throw new Error(`Unknown patient status: ${status}`);
  }
  return messages[status];
}

/**
 * Render a small inline UI icon.
 * @param {string} name Icon name.
 * @return {string} SVG markup.
 * @example
 * uiIcon("heart");
 */
export function uiIcon(name) {
  const paths = {
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
    lungs: '<path d="M6.1 4.5v5.1c0 .8-.4 1.5-1.1 1.9-1.8 1.1-3 3.2-3 5.4 0 1.7 1.4 3.1 3.1 3.1 2.7 0 4.9-2.2 4.9-4.9V4.8c0-1-.8-1.8-1.8-1.8-.8 0-1.5.6-2.1 1.5Zm11.8 0v5.1c0 .8.4 1.5 1.1 1.9 1.8 1.1 3 3.2 3 5.4 0 1.7-1.4 3.1-3.1 3.1-2.7 0-4.9-2.2-4.9-4.9V4.8c0-1 .8-1.8 1.8-1.8.8 0 1.5.6 2.1 1.5Z"/><path d="M12 3v10"/>',
    oxygen: '<circle cx="9" cy="12" r="6"/><path d="M15 6h6v6m-6 0 6-6"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
    chat: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/>',
    stethoscope: '<path d="M6 3v6a4 4 0 0 0 8 0V3M4 3h4m4 0h4"/><path d="M10 17a4 4 0 0 0 8 0v-1"/><circle cx="19" cy="13" r="2"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="m6 11 3-3 3 6 3-5 3 2M8 21h8m-4-4v4"/>',
    chart: '<path d="M8 3h8l3 3v15H5V3Z"/><path d="M9 3v4h6V3M8 12h8m-8 4h6"/>',
    bed: '<path d="M3 5v14M21 9v10M3 15h18M6 9h5a4 4 0 0 1 4 4v2H6Z"/>',
    alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
    drop: '<path d="M12 2s6 7 6 12a6 6 0 1 1-12 0c0-5 6-12 6-12Z"/>',
    rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 9"/><path d="M20 4v5h-5"/>',
    pause: '<path d="M8 5v14m8-14v14"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    volume: '<path d="M11 5 6 9H3v6h3l5 4V5Zm4.5 4a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  };
  const path = paths[name] ?? '<circle cx="12" cy="12" r="8"/>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

/**
 * Build the application shell markup.
 * @param {ReturnType<typeof groupActions>} grouped_actions Action groups.
 * @return {string} HTML markup.
 * @example
 * buildAppMarkup(groupActions());
 */
export function buildAppMarkup(grouped_actions) {
  const action_markup = Object.entries(grouped_actions)
    .map(([category, actions]) => {
      const buttons = actions
        .map((action) => `
          <button class="action-card${action.unsafe ? " action-card--unsafe" : ""}" data-action="${action.id}" type="button">
            <span class="action-card__icon">${uiIcon(action.icon)}</span>
            <span class="action-card__copy">
              <strong>${action.short_label}</strong>
              <small>${action.label}</small>
            </span>
            <span class="action-card__state" aria-hidden="true">${uiIcon("arrow")}</span>
          </button>`)
        .join("");
      return `<div class="action-list" data-action-list="${category}" ${category === "assess" ? "" : "hidden"}>${buttons}</div>`;
    })
    .join("");

  return `
    <main class="simulator" data-status="critical">
      <section class="stage" aria-label="3D patient room">
        <div class="stage__canvas" id="scene-root"></div>
        <div class="stage__wash" aria-hidden="true"></div>
        <div class="webgl-fallback" id="webgl-fallback" hidden>
          <span>${uiIcon("alert")}</span>
          <strong>3D view unavailable</strong>
          <p>The clinical controls remain available in dashboard mode.</p>
        </div>

        <header class="topbar">
          <a class="brand" href="#" aria-label="Rohy home">
            <span class="brand__mark"><i></i><i></i><i></i></span>
            <span>rohy<sup>lab</sup></span>
          </a>
          <div class="case-heading">
            <span class="eyebrow">Acute care · Room 04</span>
            <h1>Breathless at rest</h1>
          </div>
          <div class="topbar__status">
            <div class="status-chip status-chip--critical" id="status-chip">
              <span></span><strong>Critical</strong><small>Immediate support required</small>
            </div>
            <div class="clock" aria-label="Scenario time">
              <small>CASE TIME</small><strong id="case-time">00:00</strong>
            </div>
            <div class="topbar__actions">
              <button class="icon-button" id="pause-button" type="button" aria-label="Pause simulation">${uiIcon("pause")}</button>
              <button class="icon-button" id="sound-button" type="button" aria-label="Mute sounds" aria-pressed="false">${uiIcon("volume")}</button>
              <button class="icon-button" id="dashboard-button" type="button" aria-label="Toggle simplified dashboard" aria-pressed="false">${uiIcon("grid")}</button>
              <button class="icon-button" id="settings-button" type="button" aria-label="Toggle high contrast" aria-pressed="false">${uiIcon("settings")}</button>
            </div>
          </div>
        </header>

        <aside class="patient-panel glass-panel">
          <div class="panel-kicker"><span>PATIENT</span><b id="patient-state-dot">● HIGH ACUITY</b></div>
          <div class="patient-identity">
            <div class="patient-avatar-mini">DM</div>
            <div><h2>Daniel Moreau</h2><p>54 years · he/him</p></div>
          </div>
          <dl class="patient-meta">
            <div><dt>Presenting concern</dt><dd>Increasing shortness of breath</dd></div>
            <div><dt>Background</dt><dd>Obstructive airways disease</dd></div>
            <div><dt>Allergies</dt><dd>No known drug allergy</dd></div>
          </dl>
          <div class="objective-heading"><span>Priority objectives</span><strong id="objective-count">0 / 4</strong></div>
          <div class="objective-list" id="objective-list"></div>
          <button class="text-button" id="brief-button" type="button">View scenario brief <span>↗</span></button>
        </aside>

        <aside class="monitor-panel glass-panel" aria-label="Live vital signs">
          <div class="monitor-header">
            <div><span class="live-dot"></span><strong>LIVE MONITOR</strong></div>
            <span>BED 04</span>
          </div>
          <div class="ecg-block">
            <div class="ecg-label"><span>ECG · LEAD II</span><b id="rhythm-label">Sinus tachycardia</b></div>
            <svg class="ecg" viewBox="0 0 640 96" preserveAspectRatio="none" role="img" aria-label="Animated ECG waveform">
              <defs><linearGradient id="wave-glow" x1="0" x2="1"><stop stop-color="#2ae0bd"/><stop offset="1" stop-color="#9ff9df"/></linearGradient></defs>
              <path class="ecg-grid" d="M0 24H640M0 48H640M0 72H640 M40 0V96M80 0V96M120 0V96M160 0V96M200 0V96M240 0V96M280 0V96M320 0V96M360 0V96M400 0V96M440 0V96M480 0V96M520 0V96M560 0V96M600 0V96"/>
              <path id="ecg-path" class="ecg-wave" d=""/>
            </svg>
          </div>
          <div class="vital-grid">
            <div class="vital" id="vital-heart_rate"><span>HR</span><strong data-vital-value>116</strong><small>bpm</small><i>${uiIcon("heart")}</i></div>
            <div class="vital" id="vital-oxygen_saturation"><span>SpO₂</span><strong data-vital-value>86</strong><small>%</small><i>${uiIcon("oxygen")}</i></div>
            <div class="vital" id="vital-respiratory_rate"><span>RR</span><strong data-vital-value>30</strong><small>/min</small><i>${uiIcon("lungs")}</i></div>
            <div class="vital" id="vital-blood_pressure"><span>NIBP</span><strong data-vital-value>168/94</strong><small>mmHg</small><i>SYS/DIA</i></div>
            <div class="vital vital--wide" id="vital-temperature"><span>TEMP</span><strong data-vital-value>37.8</strong><small>°C</small><i>ORAL</i></div>
          </div>
          <div class="monitor-footer"><span id="last-reading">Last reading · now</span><button type="button" id="trend-button">View trends</button></div>
        </aside>

        <div class="scene-label scene-label--patient"><i></i><span>DANIEL · PATIENT</span></div>
        <div class="scene-label scene-label--monitor"><i></i><span>MONITOR</span></div>
        <div class="selection-toast" id="selection-toast" hidden></div>

        <div class="camera-controls" aria-label="Camera views">
          <span>${uiIcon("rotate")} VIEW</span>
          <button class="camera-button is-active" data-camera="overview" type="button"><kbd>1</kbd> Overview</button>
          <button class="camera-button" data-camera="patient" type="button"><kbd>2</kbd> Patient</button>
          <button class="camera-button" data-camera="airway" type="button"><kbd>3</kbd> Airway</button>
          <button class="camera-button" data-camera="monitor" type="button"><kbd>4</kbd> Monitor</button>
          <button class="camera-button" data-camera="equipment" type="button"><kbd>5</kbd> Equipment</button>
        </div>

        <div class="patient-caption" id="patient-caption">
          <span class="caption-speaker">DANIEL</span>
          <p>“I can't seem to catch my breath… it's much worse today.”</p>
        </div>

        <section class="activity-panel glass-panel" aria-label="Clinical timeline">
          <div class="activity-heading"><span>CLINICAL TIMELINE</span><button id="timeline-button" type="button">Expand</button></div>
          <div id="timeline-list" class="timeline-list">
            <article><time>00:00</time><i></i><p>Patient arrived in respiratory distress.</p></article>
          </div>
        </section>

        <section class="action-dock glass-panel" aria-label="Clinical actions">
          <div class="action-dock__top">
            <div class="action-tabs" role="tablist" aria-label="Action category">
              <button class="is-active" data-category="assess" role="tab" aria-selected="true" type="button">Assess <span>3</span></button>
              <button data-category="investigate" role="tab" aria-selected="false" type="button">Investigate <span>2</span></button>
              <button data-category="treat" role="tab" aria-selected="false" type="button">Treat <span>5</span></button>
            </div>
            <div class="score-block"><span>CLINICAL SCORE</span><strong id="score-value">000</strong></div>
          </div>
          <div class="action-lists">${action_markup}</div>
          <p class="prototype-note">Training prototype · not clinical guidance</p>
        </section>

        <div class="sr-only" id="live-region" aria-live="polite" aria-atomic="true"></div>
      </section>

      <div class="modal-layer" id="brief-modal" role="dialog" aria-modal="true" aria-labelledby="brief-title">
        <article class="brief-card">
          <div class="brief-card__visual">
            <span class="brief-tag">INTERACTIVE 3D CASE</span>
            <div class="brief-orbit" aria-hidden="true"><i></i><i></i><i></i><span>${uiIcon("lungs")}</span></div>
            <div class="brief-patient"><strong>DM</strong><span>54</span></div>
          </div>
          <div class="brief-card__content">
            <span class="eyebrow">Rohy clinical simulation · Case 01</span>
            <h2 id="brief-title">Breathless<br/>at rest</h2>
            <p>Daniel Moreau, 54, has become acutely short of breath. Enter the room, assess his condition, and respond to changing physiology.</p>
            <div class="brief-goals">
              <div><span>01</span><p><strong>Assess</strong>Identify the immediate threat.</p></div>
              <div><span>02</span><p><strong>Stabilize</strong>Choose time-critical actions.</p></div>
              <div><span>03</span><p><strong>Reassess</strong>Watch the patient respond.</p></div>
            </div>
            <div class="brief-controls"><span>Drag to orbit</span><span>Scroll to zoom</span><span>1–5 camera views</span></div>
            <button class="begin-button" id="begin-button" type="button">Enter patient room ${uiIcon("arrow")}</button>
          </div>
        </article>
      </div>

      <div class="modal-layer modal-layer--result" id="result-modal" role="dialog" aria-modal="true" aria-labelledby="result-title" hidden>
        <article class="result-card">
          <div class="result-icon">${uiIcon("check")}</div>
          <span class="eyebrow">Scenario checkpoint reached</span>
          <h2 id="result-title">Daniel is stabilizing.</h2>
          <p>You assessed the immediate problem, supported oxygenation, began targeted treatment, and escalated care.</p>
          <div class="result-stats"><div><span>Score</span><strong id="result-score">000</strong></div><div><span>Time</span><strong id="result-time">00:00</strong></div><div><span>Actions</span><strong id="result-actions">0</strong></div></div>
          <button class="begin-button" id="continue-button" type="button">Continue in room ${uiIcon("arrow")}</button>
          <button class="result-secondary" id="restart-button" type="button">Restart scenario</button>
        </article>
      </div>
    </main>`;
}

/**
 * Initialize the interactive Rohy patient-room application.
 * @return {void}
 * @example
 * boot();
 */
export function boot() {
  const app = document.querySelector("#app");
  if (!app) {
    throw new Error("#app root was not found.");
  }
  app.innerHTML = buildAppMarkup(groupActions());

  let state = createSimulation({
    log: [createLogEntry(0, "Patient arrived in respiratory distress.", "system")],
  });
  let active_category = "assess";
  let scene_controller = null;
  let toast_timeout = null;
  let result_shown = false;

  const elements = {
    simulator: document.querySelector(".simulator"),
    scene_root: document.querySelector("#scene-root"),
    fallback: document.querySelector("#webgl-fallback"),
    time: document.querySelector("#case-time"),
    status: document.querySelector("#status-chip"),
    patient_state_dot: document.querySelector("#patient-state-dot"),
    objectives: document.querySelector("#objective-list"),
    objective_count: document.querySelector("#objective-count"),
    score: document.querySelector("#score-value"),
    timeline: document.querySelector("#timeline-list"),
    caption: document.querySelector("#patient-caption"),
    live_region: document.querySelector("#live-region"),
    selection_toast: document.querySelector("#selection-toast"),
    brief_modal: document.querySelector("#brief-modal"),
    result_modal: document.querySelector("#result-modal"),
    pause_button: document.querySelector("#pause-button"),
    ecg_path: document.querySelector("#ecg-path"),
  };

  const showToast = (message) => {
    window.clearTimeout(toast_timeout);
    elements.selection_toast.textContent = message;
    elements.selection_toast.hidden = false;
    elements.selection_toast.classList.remove("is-visible");
    window.requestAnimationFrame(() => elements.selection_toast.classList.add("is-visible"));
    toast_timeout = window.setTimeout(() => {
      elements.selection_toast.classList.remove("is-visible");
    }, 2600);
  };

  const setCategory = (category) => {
    if (!["assess", "investigate", "treat"].includes(category)) {
      throw new Error(`Unknown action category: ${category}`);
    }
    active_category = category;
    document.querySelectorAll("[data-category]").forEach((button) => {
      const is_active = button.dataset.category === category;
      button.classList.toggle("is-active", is_active);
      button.setAttribute("aria-selected", String(is_active));
    });
    document.querySelectorAll("[data-action-list]").forEach((list) => {
      list.hidden = list.dataset.actionList !== category;
    });
  };

  const handleSceneSelection = (selection) => {
    const mapped_action = SELECTION_ACTIONS[selection.id];
    showToast(selection.label);
    if (mapped_action) {
      setCategory(mapped_action.category);
      document.querySelector(`[data-action="${mapped_action.action_id}"]`)?.focus({ preventScroll: true });
    }
  };

  import("./scene.js")
    .then(({ initClinicalScene }) => {
      scene_controller = initClinicalScene(elements.scene_root, handleSceneSelection);
      const vitals = deriveVitals(state);
      scene_controller.update(state.status, vitals, state.elapsed_seconds);
      scene_controller.ready.then((patient) => {
        if (patient.userData.avatar_source !== "procedural fallback") {
          elements.live_region.textContent = "Rigged full-body patient loaded.";
        }
      });
    })
    .catch((error) => {
      elements.fallback.hidden = false;
      elements.simulator.classList.add("is-dashboard");
      console.warn("Rohy 3D scene could not start.", error);
    });

  const renderObjectives = () => {
    const objectives = deriveObjectives(state.actions);
    elements.objectives.innerHTML = objectives
      .map((objective, index) => `
        <div class="objective${objective.complete ? " is-complete" : ""}">
          <span>${objective.complete ? uiIcon("check") : String(index + 1).padStart(2, "0")}</span>
          <p>${objective.label}</p>
        </div>`)
      .join("");
    elements.objective_count.textContent = `${objectives.filter((objective) => objective.complete).length} / ${objectives.length}`;
  };

  const renderTimeline = () => {
    elements.timeline.innerHTML = state.log
      .slice(-4)
      .reverse()
      .map((event) => `
        <article class="timeline-event timeline-event--${event.type}">
          <time>${formatElapsed(event.time)}</time><i></i><p>${event.message}</p>
        </article>`)
      .join("");
  };

  const renderVitals = (vitals) => {
    const vital_values = {
      heart_rate: vitals.heart_rate,
      oxygen_saturation: vitals.oxygen_saturation,
      respiratory_rate: vitals.respiratory_rate,
      blood_pressure: `${vitals.systolic}/${vitals.diastolic}`,
      temperature: vitals.temperature.toFixed(1),
    };
    Object.entries(vital_values).forEach(([vital_name, value]) => {
      const vital_element = document.querySelector(`#vital-${vital_name}`);
      vital_element.querySelector("[data-vital-value]").textContent = value;
      const severity_value = vital_name === "blood_pressure" ? vitals.systolic : Number(value);
      vital_element.dataset.severity = vitalSeverity(vital_name, severity_value);
    });
    document.querySelector("#rhythm-label").textContent = vitals.heart_rate > 100 ? "Sinus tachycardia" : "Sinus rhythm";
  };

  const showResult = () => {
    if (result_shown) return;
    result_shown = true;
    document.querySelector("#result-score").textContent = String(state.score).padStart(3, "0");
    document.querySelector("#result-time").textContent = formatElapsed(state.elapsed_seconds);
    document.querySelector("#result-actions").textContent = state.actions.length;
    elements.result_modal.hidden = false;
    window.requestAnimationFrame(() => elements.result_modal.classList.add("is-visible"));
    document.querySelector("#continue-button").focus();
  };

  const render = () => {
    const vitals = deriveVitals(state);
    const current_status = derivePatientStatus(vitals, state.actions);
    state = { ...state, status: current_status };
    elements.simulator.dataset.status = current_status;
    elements.time.textContent = formatElapsed(state.elapsed_seconds);
    elements.status.className = `status-chip status-chip--${current_status}`;
    elements.status.innerHTML = `<span></span><strong>${current_status}</strong><small>${getStatusCopy(current_status)}</small>`;
    elements.patient_state_dot.textContent = current_status === "stable" ? "● STABLE" : current_status === "stabilizing" ? "● RESPONDING" : "● HIGH ACUITY";
    elements.score.textContent = String(state.score).padStart(3, "0");
    elements.pause_button.innerHTML = state.running ? uiIcon("pause") : uiIcon("play");
    elements.pause_button.setAttribute("aria-label", state.running ? "Pause simulation" : "Resume simulation");
    renderVitals(vitals);
    renderObjectives();
    renderTimeline();
    scene_controller?.update(current_status, vitals, state.elapsed_seconds);

    document.querySelectorAll("[data-action]").forEach((button) => {
      const complete = state.actions.includes(button.dataset.action);
      button.classList.toggle("is-complete", complete);
      button.setAttribute("aria-pressed", String(complete));
      if (complete) button.querySelector(".action-card__state").innerHTML = uiIcon("check");
    });

    if (state.completed) {
      window.setTimeout(showResult, 600);
    }
  };

  const performAction = (action_id) => {
    const transition = applyClinicalAction(state, action_id);
    state = transition.state;
    const definition = ACTION_DEFINITIONS[action_id];
    elements.caption.querySelector("p").textContent = `“${PATIENT_REPLIES[action_id]}”`;
    elements.caption.classList.remove("is-speaking");
    window.requestAnimationFrame(() => elements.caption.classList.add("is-speaking"));
    elements.live_region.textContent = transition.event.message;
    showToast(transition.duplicate ? `${definition.short_label} already completed` : `${definition.short_label} completed`);
    render();
  };

  document.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => setCategory(button.dataset.category));
  });
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => performAction(button.dataset.action));
  });
  document.querySelectorAll("[data-camera]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-camera]").forEach((camera_button) => camera_button.classList.remove("is-active"));
      button.classList.add("is-active");
      scene_controller?.focusPreset(button.dataset.camera);
    });
  });

  document.querySelector("#begin-button").addEventListener("click", () => {
    state = { ...state, running: true };
    elements.brief_modal.classList.add("is-closing");
    window.setTimeout(() => {
      elements.brief_modal.hidden = true;
      elements.brief_modal.classList.remove("is-closing");
    }, 420);
    render();
  });
  document.querySelector("#brief-button").addEventListener("click", () => {
    elements.brief_modal.hidden = false;
    window.requestAnimationFrame(() => elements.brief_modal.classList.remove("is-closing"));
  });
  elements.pause_button.addEventListener("click", () => {
    state = { ...state, running: !state.running };
    showToast(state.running ? "Simulation resumed" : "Simulation paused");
    render();
  });
  document.querySelector("#sound-button").addEventListener("click", (event) => {
    const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
    event.currentTarget.setAttribute("aria-pressed", String(!pressed));
    showToast(pressed ? "Audio cues enabled" : "Audio cues muted");
  });
  document.querySelector("#dashboard-button").addEventListener("click", (event) => {
    const enabled = !elements.simulator.classList.contains("is-dashboard");
    elements.simulator.classList.toggle("is-dashboard", enabled);
    event.currentTarget.setAttribute("aria-pressed", String(enabled));
    showToast(enabled ? "Simplified dashboard view" : "Interactive 3D view");
  });
  document.querySelector("#settings-button").addEventListener("click", (event) => {
    const enabled = !elements.simulator.classList.contains("is-high-contrast");
    elements.simulator.classList.toggle("is-high-contrast", enabled);
    event.currentTarget.setAttribute("aria-pressed", String(enabled));
    showToast(enabled ? "High contrast enabled" : "High contrast disabled");
  });
  document.querySelector("#timeline-button").addEventListener("click", () => {
    document.querySelector(".activity-panel").classList.toggle("is-expanded");
  });
  document.querySelector("#trend-button").addEventListener("click", () => {
    showToast("Trend review will unlock after three readings");
  });
  document.querySelector("#continue-button").addEventListener("click", () => {
    elements.result_modal.classList.remove("is-visible");
    window.setTimeout(() => { elements.result_modal.hidden = true; }, 300);
    state = { ...state, completed: false, running: true };
  });
  document.querySelector("#restart-button").addEventListener("click", () => {
    state = createSimulation({
      running: true,
      log: [createLogEntry(0, "Scenario restarted.", "system")],
    });
    result_shown = false;
    elements.result_modal.classList.remove("is-visible");
    window.setTimeout(() => { elements.result_modal.hidden = true; }, 300);
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return;
    const camera_names = ["overview", "patient", "airway", "monitor", "equipment"];
    if (/^[1-5]$/.test(event.key)) {
      document.querySelector(`[data-camera="${camera_names[Number(event.key) - 1]}"]`)?.click();
    }
    if (event.code === "Space" && elements.brief_modal.hidden) {
      event.preventDefault();
      elements.pause_button.click();
    }
  });

  window.setInterval(() => {
    state = tickSimulation(state, 1);
    if (state.running) render();
  }, 1000);
  let wave_phase = 0;
  window.setInterval(() => {
    wave_phase += 0.18;
    const vitals = deriveVitals(state);
    elements.ecg_path.setAttribute("d", createWavePath(vitals.heart_rate, 640, 96, wave_phase));
  }, 90);

  render();
}

if (typeof document !== "undefined") {
  boot();
}
