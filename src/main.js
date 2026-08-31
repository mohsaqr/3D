import "./styles.css";
import {
  ACTION_DEFINITIONS,
  applyClinicalAction,
  createLogEntry,
  createSimulation,
  deriveObjectives,
  derivePatientStatus,
  deriveVitals,
  deriveVitalTrends,
  groupActions,
  tickSimulation,
  validateVitals,
} from "./simulation.js";
import {
  beepFrequencyForSpo2,
  buildRecordsMarkup,
  buildTreatmentsMarkup,
  buildTrendsMarkup,
  createWavePath,
  formatElapsed,
  getStatusCopy,
  sampleTrendRows,
  vitalSeverity,
} from "./ui-helpers.js";

export const DEFAULT_PATIENT = Object.freeze({
  name: "Daniel Moreau",
  initials: "DM",
  age: 54,
  pronouns: "he/him",
  speaker: "DANIEL",
  presenting_concern: "Increasing shortness of breath",
  background: "Obstructive airways disease",
  allergies: "No known drug allergy",
  location: "Acute care · Room 04",
  bed_label: "BED 04",
  case_title: "Breathless at rest",
  arrival_note: "Patient arrived in respiratory distress.",
  opening_line: "I can't seem to catch my breath… it's much worse today.",
});

// Bound-mode base record: neutral placeholders only. The demo Daniel record
// must never leak into a host-driven room — a fabricated complaint, history,
// or allergy status shown next to real vitals would read as clinical fact.
export const NEUTRAL_PATIENT = Object.freeze({
  name: "—",
  initials: "—",
  age: "—",
  pronouns: "they/them",
  speaker: "PATIENT",
  presenting_concern: "—",
  background: "—",
  allergies: "—",
  location: "Live case",
  bed_label: "LIVE",
  case_title: "Patient room",
  arrival_note: "Live monitoring connected.",
  opening_line: "",
});

const PATIENT_STATUSES = Object.freeze(["critical", "unstable", "stabilizing", "stable"]);

/**
 * Create a bedside audio engine driven by Web Audio.
 * The pulse beep tracks heart rate and its pitch falls with desaturation.
 * @return {{enable: () => void, setMuted: (muted: boolean) => void, beat: (vitals: {heart_rate: number, oxygen_saturation: number}) => void}}
 *   Monitor audio controller.
 * @example
 * const audio = createMonitorAudio();
 */
export function createMonitorAudio() {
  let context = null;
  let muted = false;

  return {
    enable() {
      if (context || typeof window === "undefined") return;
      const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextClass) return;
      context = new AudioContextClass();
    },
    setMuted(next_muted) {
      muted = Boolean(next_muted);
    },
    beat(vitals) {
      if (!context || muted || !Number.isFinite(vitals?.oxygen_saturation)) return;
      if (context.state === "suspended") {
        context.resume().catch(() => undefined);
        return;
      }
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = beepFrequencyForSpo2(vitals.oxygen_saturation);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.1);
    },
  };
}

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
 * @param {typeof DEFAULT_PATIENT} [patient] Patient identity shown in the panels.
 * @param {"standalone"|"bound"} [mode] "bound" omits the built-in scenario chrome
 *   (brief, objectives, action dock, score, pause) because the host drives the case.
 * @param {"internal"|"host"} [waveform] "host" renders an empty ECG canvas the
 *   host application draws its own signal into, instead of the built-in SVG wave.
 * @param {{records?: boolean, treatments?: boolean, slim_chrome?: boolean}} [features]
 *   Which host-fed panels (medical records, treatment ordering) to render entry
 *   points for; slim_chrome drops the room's own brand block for hosts that
 *   provide their own application chrome.
 * @return {string} HTML markup.
 * @example
 * buildAppMarkup(groupActions());
 */
export function buildAppMarkup(grouped_actions, patient = DEFAULT_PATIENT, mode = "standalone", waveform = "internal", features = {}) {
  const bound = mode === "bound";
  const slim = Boolean(features.slim_chrome);
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
    <main class="simulator${bound ? " simulator--bound" : ""}${slim ? " simulator--embedded" : ""}" data-status="critical">
      <section class="stage" aria-label="3D patient room">
        <div class="stage__canvas" id="scene-root"></div>
        <div class="stage__wash" aria-hidden="true"></div>
        <div class="webgl-fallback" id="webgl-fallback" hidden>
          <span>${uiIcon("alert")}</span>
          <strong>3D view unavailable</strong>
          <p>The clinical controls remain available in dashboard mode.</p>
        </div>
        <div class="avatar-notice" id="avatar-notice" hidden role="status">
          ${uiIcon("alert")} Reduced visuals · the full patient model could not load
        </div>

        <header class="topbar">
          ${slim ? "" : `<span class="brand" aria-label="Rohy lab">
            <span class="brand__mark"><i></i><i></i><i></i></span>
            <span>rohy<sup>lab</sup></span>
          </span>`}
          <div class="case-heading">
            <span class="eyebrow">${patient.location}</span>
            <h1>${patient.case_title}</h1>
          </div>
          <div class="topbar__status">
            <div class="status-chip status-chip--critical" id="status-chip">
              <span></span><strong>Critical</strong><small>Immediate support required</small>
            </div>
            <div class="clock" aria-label="Scenario time">
              <small>CASE TIME</small><strong id="case-time">00:00</strong>
            </div>
            <div class="topbar__actions">
              ${bound ? "" : `<button class="icon-button" id="pause-button" type="button" aria-label="Pause simulation">${uiIcon("pause")}</button>
              <button class="icon-button" id="sound-button" type="button" aria-label="Mute sounds" aria-pressed="false">${uiIcon("volume")}</button>
              <button class="icon-button" id="dashboard-button" type="button" aria-label="Toggle simplified dashboard" aria-pressed="false">${uiIcon("grid")}</button>`}
              <button class="icon-button" id="settings-button" type="button" aria-label="Toggle high contrast" aria-pressed="false">${uiIcon("settings")}</button>
            </div>
          </div>
        </header>

        ${bound ? "" : `<aside class="patient-panel glass-panel">
          <div class="panel-kicker"><span>PATIENT</span><b id="patient-state-dot">● HIGH ACUITY</b></div>
          <div class="patient-identity">
            <div class="patient-avatar-mini">${patient.initials}</div>
            <div><h2>${patient.name}</h2><p>${patient.age} years · ${patient.pronouns}</p></div>
          </div>
          <dl class="patient-meta">
            <div><dt>Presenting concern</dt><dd>${patient.presenting_concern}</dd></div>
            <div><dt>Background</dt><dd>${patient.background}</dd></div>
            <div><dt>Allergies</dt><dd>${patient.allergies}</dd></div>
          </dl>
          <div class="objective-heading"><span>Priority objectives</span><strong id="objective-count">0 / 4</strong></div>
          <div class="objective-list" id="objective-list"></div>
          <button class="text-button" id="brief-button" type="button">View scenario brief <span>↗</span></button>
        </aside>`}

        <aside class="monitor-panel glass-panel" aria-label="Live vital signs">
          <div class="monitor-header">
            <div><span class="live-dot"></span><strong>LIVE MONITOR</strong></div>
            <span>${patient.bed_label}</span>
          </div>
          <div class="ecg-block">
            <div class="ecg-label"><span>ECG · LEAD II</span><b id="rhythm-label">Sinus tachycardia</b></div>
            ${waveform === "host"
              ? `<canvas class="ecg ecg--host" id="ecg-canvas" width="640" height="96" role="img" aria-label="Live ECG waveform"></canvas>`
              : `<svg class="ecg" viewBox="0 0 640 96" preserveAspectRatio="none" role="img" aria-label="Animated ECG waveform">
              <defs><linearGradient id="wave-glow" x1="0" x2="1"><stop stop-color="#2ae0bd"/><stop offset="1" stop-color="#9ff9df"/></linearGradient></defs>
              <path class="ecg-grid" d="M0 24H640M0 48H640M0 72H640 M40 0V96M80 0V96M120 0V96M160 0V96M200 0V96M240 0V96M280 0V96M320 0V96M360 0V96M400 0V96M440 0V96M480 0V96M520 0V96M560 0V96M600 0V96"/>
              <path id="ecg-path" class="ecg-wave" d=""/>
            </svg>`}
          </div>
          <div class="vital-grid">
            <div class="vital" id="vital-heart_rate"><span>HR</span><strong data-vital-value>116</strong><small>bpm</small><i>${uiIcon("heart")}</i></div>
            <div class="vital" id="vital-oxygen_saturation"><span>SpO₂</span><strong data-vital-value>86</strong><small>%</small><i>${uiIcon("oxygen")}</i></div>
            <div class="vital" id="vital-respiratory_rate"><span>RR</span><strong data-vital-value>30</strong><small>/min</small><i>${uiIcon("lungs")}</i></div>
            <div class="vital" id="vital-blood_pressure"><span>NIBP</span><strong data-vital-value>168/94</strong><small>mmHg</small><i>SYS/DIA</i></div>
            <div class="vital vital--wide" id="vital-temperature"><span>TEMP</span><strong data-vital-value>37.8</strong><small>°C</small><i>ORAL</i></div>
          </div>
          <div class="monitor-footer">
            <span id="last-reading">Last reading · now</span>
            <span class="monitor-footer__actions">
              ${features.records ? `<button type="button" id="records-button">Records</button>` : ""}
              ${features.treatments ? `<button type="button" id="treatments-button">Treatments</button>` : ""}
              <button type="button" id="trend-button">View trends</button>
            </span>
          </div>
        </aside>

        ${bound ? "" : `<div class="scene-label scene-label--patient"><i></i><span>${patient.speaker} · PATIENT</span></div>
        <div class="scene-label scene-label--monitor"><i></i><span>MONITOR</span></div>`}
        <div class="selection-toast" id="selection-toast" hidden></div>

        <div class="camera-controls" aria-label="Camera views">
          <span>${uiIcon("rotate")} VIEW</span>
          <button class="camera-button is-active" data-camera="overview" type="button"><kbd>1</kbd> Overview</button>
          <button class="camera-button" data-camera="patient" type="button"><kbd>2</kbd> Patient</button>
          <button class="camera-button" data-camera="airway" type="button"><kbd>3</kbd> Airway</button>
          <button class="camera-button" data-camera="monitor" type="button"><kbd>4</kbd> Monitor</button>
          <button class="camera-button" data-camera="equipment" type="button"><kbd>5</kbd> Equipment</button>
        </div>

        <div class="patient-caption" id="patient-caption"${bound ? " hidden" : ""}>
          <span class="caption-speaker">${patient.speaker}</span>
          <p>“${patient.opening_line}”</p>
        </div>

        ${bound ? "" : `<section class="activity-panel glass-panel" aria-label="Clinical timeline">
          <div class="activity-heading"><span>CLINICAL TIMELINE</span><button id="timeline-button" type="button">Expand</button></div>
          <div id="timeline-list" class="timeline-list">
            <article><time>00:00</time><i></i><p>${patient.arrival_note}</p></article>
          </div>
        </section>`}

        ${bound ? "" : `
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
        </section>`}

        <div class="sr-only" id="live-region" aria-live="polite" aria-atomic="true"></div>
      </section>

      ${bound ? "" : `
      <div class="modal-layer" id="brief-modal" role="dialog" aria-modal="true" aria-labelledby="brief-title">
        <article class="brief-card">
          <div class="brief-card__visual">
            <span class="brief-tag">INTERACTIVE 3D CASE</span>
            <div class="brief-orbit" aria-hidden="true"><i></i><i></i><i></i><span>${uiIcon("lungs")}</span></div>
            <div class="brief-patient"><strong>${patient.initials}</strong><span>${patient.age}</span></div>
          </div>
          <div class="brief-card__content">
            <span class="eyebrow">Rohy clinical simulation · Case 01</span>
            <h2 id="brief-title">${patient.case_title}</h2>
            <p>${patient.name}, ${patient.age}, has become acutely short of breath. Enter the room, assess his condition, and respond to changing physiology.</p>
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
          <h2 id="result-title">${patient.name.split(" ")[0]} is stabilizing.</h2>
          <p>You assessed the immediate problem, supported oxygenation, began targeted treatment, and escalated care.</p>
          <div class="result-stats"><div><span>Score</span><strong id="result-score">000</strong></div><div><span>Time</span><strong id="result-time">00:00</strong></div><div><span>Actions</span><strong id="result-actions">0</strong></div></div>
          <button class="begin-button" id="continue-button" type="button">Continue in room ${uiIcon("arrow")}</button>
          <button class="result-secondary" id="restart-button" type="button">Restart scenario</button>
        </article>
      </div>`}

      <div class="modal-layer modal-layer--trends" id="trends-modal" role="dialog" aria-modal="true" aria-labelledby="trends-title" hidden>
        <article class="trends-card">
          <div class="trends-card__header">
            <div>
              <span class="eyebrow">${patient.bed_label} · Case trends</span>
              <h2 id="trends-title">Vital sign trends</h2>
            </div>
            <button class="icon-button" id="trends-close" type="button" aria-label="Close trends">✕</button>
          </div>
          <div id="trends-body" class="trends-body"></div>
          <p class="trends-note">${bound ? "Recorded from the live monitor feed." : "Reconstructed from the clinical timeline of this case."}</p>
        </article>
      </div>

      ${features.records ? `
      <div class="modal-layer modal-layer--trends" id="records-modal" role="dialog" aria-modal="true" aria-labelledby="records-title" hidden>
        <article class="trends-card records-card">
          <div class="trends-card__header">
            <div>
              <span class="eyebrow">${patient.name} · Clinical record</span>
              <h2 id="records-title">Medical records</h2>
            </div>
            <button class="icon-button" id="records-close" type="button" aria-label="Close records">✕</button>
          </div>
          <div id="records-body" class="records-body"></div>
        </article>
      </div>` : ""}

      ${features.treatments ? `
      <div class="modal-layer modal-layer--trends" id="treatments-modal" role="dialog" aria-modal="true" aria-labelledby="treatments-title" hidden>
        <article class="trends-card records-card">
          <div class="trends-card__header">
            <div>
              <span class="eyebrow">${patient.bed_label} · Orders</span>
              <h2 id="treatments-title">Treatment</h2>
            </div>
            <button class="icon-button" id="treatments-close" type="button" aria-label="Close treatments">✕</button>
          </div>
          <div id="treatments-body" class="records-body"></div>
        </article>
      </div>` : ""}
    </main>`;
}

/**
 * Mount the interactive patient room into a container element.
 *
 * Standalone mode (default) runs the built-in deterministic scenario engine.
 * Bound mode renders the same room, monitor, timeline, and patient rig, but the
 * host application owns the case: it supplies the patient record up front and
 * then streams vitals with `controller.update()` and events with
 * `controller.addTimelineEvent()`; the built-in scenario chrome (brief,
 * objectives, action dock, score, pause) is omitted.
 *
 * @param {Element} container Element that will own the room DOM.
 * @param {{
 *   patient?: Partial<typeof DEFAULT_PATIENT>,
 *   avatar_url?: string,
 *   mode?: "standalone"|"bound",
 *   waveform?: "internal"|"host",
 *   chrome?: "full"|"room",
 *   records?: Array<object>,
 *   treatments?: {available?: Array<object>},
 *   on_event?: (event: object) => void,
 * }} [options] Mount configuration. chrome: "room" drops the room's own brand
 *   block for hosts that render it inside their own application chrome.
 * @return {{
 *   dispose: () => void,
 *   update: (vitals: object, status: string|null, elapsed_seconds: number) => void,
 *   addTimelineEvent: (message: string, type?: string, time?: number) => void,
 *   say: (line: string) => void,
 *   applyAction: (action_id: string) => void,
 *   focusPreset: (name: string) => void,
 *   getState: () => object,
 * }} Room controller.
 * @example
 * const room = mountPatientRoom(document.querySelector("#app"));
 */
export function mountPatientRoom(container, options = {}) {
  if (!container || typeof container.querySelector !== "function") {
    throw new Error("container must be a DOM element.");
  }
  const mode = options.mode ?? "standalone";
  if (!["standalone", "bound"].includes(mode)) {
    throw new Error(`Unknown mount mode: ${mode}`);
  }
  const waveform = options.waveform ?? "internal";
  if (!["internal", "host"].includes(waveform)) {
    throw new Error(`Unknown waveform mode: ${waveform}`);
  }
  const chrome = options.chrome ?? "full";
  if (!["full", "room"].includes(chrome)) {
    throw new Error(`Unknown chrome mode: ${chrome}`);
  }
  if (options.on_event !== undefined && typeof options.on_event !== "function") {
    throw new Error("options.on_event must be a function.");
  }
  const bound = mode === "bound";
  const patient = { ...(bound ? NEUTRAL_PATIENT : DEFAULT_PATIENT), ...(options.patient ?? {}) };
  const emit = (event) => options.on_event?.({ mode, ...event });

  if (options.records !== undefined) {
    buildRecordsMarkup(options.records); // fail fast on a malformed record set
  }
  if (options.treatments !== undefined
    && (typeof options.treatments !== "object" || options.treatments === null
      || (options.treatments.available !== undefined && !Array.isArray(options.treatments.available)))) {
    throw new Error("options.treatments must be an object with an optional available array.");
  }
  const features = {
    records: options.records !== undefined,
    treatments: options.treatments !== undefined,
    slim_chrome: chrome === "room",
  };
  let available_treatments = options.treatments?.available ?? [];
  let active_treatments = [];

  container.classList.add("rohy3d-root");
  container.innerHTML = buildAppMarkup(groupActions(), patient, mode, waveform, features);
  const root = container;

  let state = createSimulation({
    running: bound,
    log: [createLogEntry(0, patient.arrival_note, "system")],
  });
  let bound_vitals = null;
  let rhythm_override = null;
  let scene_controller = null;
  let toast_timeout = null;
  let result_shown = false;
  let timeline_expanded = false;
  let disposed = false;
  const bound_history = [];
  const timers = { intervals: [], timeouts: new Set() };
  const monitor_audio = createMonitorAudio();

  const elements = {
    simulator: root.querySelector(".simulator"),
    scene_root: root.querySelector("#scene-root"),
    fallback: root.querySelector("#webgl-fallback"),
    time: root.querySelector("#case-time"),
    status: root.querySelector("#status-chip"),
    patient_state_dot: root.querySelector("#patient-state-dot"),
    objectives: root.querySelector("#objective-list"),
    objective_count: root.querySelector("#objective-count"),
    score: root.querySelector("#score-value"),
    timeline: root.querySelector("#timeline-list"),
    caption: root.querySelector("#patient-caption"),
    live_region: root.querySelector("#live-region"),
    selection_toast: root.querySelector("#selection-toast"),
    brief_modal: root.querySelector("#brief-modal"),
    result_modal: root.querySelector("#result-modal"),
    trends_modal: root.querySelector("#trends-modal"),
    trends_body: root.querySelector("#trends-body"),
    records_modal: root.querySelector("#records-modal"),
    records_body: root.querySelector("#records-body"),
    treatments_modal: root.querySelector("#treatments-modal"),
    treatments_body: root.querySelector("#treatments-body"),
    treatments_button: root.querySelector("#treatments-button"),
    pause_button: root.querySelector("#pause-button"),
    timeline_button: root.querySelector("#timeline-button"),
    last_reading: root.querySelector("#last-reading"),
    avatar_notice: root.querySelector("#avatar-notice"),
    ecg_path: root.querySelector("#ecg-path"),
  };

  const currentVitals = () => (bound ? bound_vitals ?? deriveVitals(state) : deriveVitals(state));

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
    root.querySelectorAll("[data-category]").forEach((button) => {
      const is_active = button.dataset.category === category;
      button.classList.toggle("is-active", is_active);
      button.setAttribute("aria-selected", String(is_active));
    });
    root.querySelectorAll("[data-action-list]").forEach((list) => {
      list.hidden = list.dataset.actionList !== category;
    });
  };

  const openModal = (modal, focus_selector) => {
    if (!modal) return;
    modal.hidden = false;
    window.requestAnimationFrame(() => modal.classList.add("is-visible"));
    if (focus_selector) root.querySelector(focus_selector)?.focus();
  };
  const closeModal = (modal) => {
    if (!modal) return;
    modal.classList.remove("is-visible");
    const timeout_id = window.setTimeout(() => {
      timers.timeouts.delete(timeout_id);
      modal.hidden = true;
    }, 300);
    timers.timeouts.add(timeout_id);
  };

  const renderTreatments = () => {
    if (!elements.treatments_body) return;
    elements.treatments_body.innerHTML = buildTreatmentsMarkup(active_treatments, available_treatments);
    if (elements.treatments_button) {
      elements.treatments_button.textContent = active_treatments.length > 0
        ? `Treatments (${active_treatments.length})`
        : "Treatments";
    }
  };
  const openRecords = () => {
    if (!elements.records_modal) return;
    elements.records_body.innerHTML = buildRecordsMarkup(options.records);
    openModal(elements.records_modal, "#records-close");
  };
  const openTreatments = () => {
    if (!elements.treatments_modal) return;
    renderTreatments();
    openModal(elements.treatments_modal, "#treatments-close");
  };

  const handleSceneSelection = (selection) => {
    showToast(selection.label);
    emit({ type: "selection", id: selection.id, label: selection.label });
    if (bound) {
      // In a host-driven room the 3D objects open the matching live panel.
      if (selection.id === "chart" && features.records) openRecords();
      if ((selection.id === "iv" || selection.id === "oxygen") && features.treatments) openTreatments();
      if (selection.id === "monitor") root.querySelector("#trend-button")?.click();
      return;
    }
    const mapped_action = SELECTION_ACTIONS[selection.id];
    if (mapped_action) {
      setCategory(mapped_action.category);
      root.querySelector(`[data-action="${mapped_action.action_id}"]`)?.focus({ preventScroll: true });
    }
  };

  import("./scene.js")
    .then(({ initClinicalScene }) => {
      if (disposed) return;
      scene_controller = initClinicalScene(elements.scene_root, handleSceneSelection, {
        avatar_url: options.avatar_url,
      });
      scene_controller.update(state.status, currentVitals(), state.elapsed_seconds);
      scene_controller.ready.then((loaded_patient) => {
        if (disposed) return;
        const fallback = loaded_patient.userData.avatar_source === "procedural fallback";
        emit({ type: "avatar", fallback, source: loaded_patient.userData.avatar_source });
        if (!fallback) {
          elements.live_region.textContent = "Rigged full-body patient loaded.";
        } else {
          elements.avatar_notice.hidden = false;
          elements.live_region.textContent = "The full patient model could not load; showing reduced visuals.";
        }
      });
    })
    .catch((error) => {
      if (disposed) return;
      elements.fallback.hidden = false;
      elements.simulator.classList.add("is-dashboard");
      console.warn("Rohy 3D scene could not start.", error);
    });

  const renderObjectives = () => {
    if (!elements.objectives) return;
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
    if (!elements.timeline) return;
    const visible_events = timeline_expanded ? state.log : state.log.slice(-4);
    elements.timeline.innerHTML = visible_events
      .slice()
      .reverse()
      .map((event) => `
        <article class="timeline-event timeline-event--${event.type}">
          <time>${formatElapsed(event.time)}</time><i></i><p>${event.message}</p>
        </article>`)
      .join("");
    elements.timeline_button.textContent = timeline_expanded ? "Collapse" : "Expand";
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
      const vital_element = root.querySelector(`#vital-${vital_name}`);
      vital_element.querySelector("[data-vital-value]").textContent = value;
      const severity_value = vital_name === "blood_pressure" ? vitals.systolic : Number(value);
      vital_element.dataset.severity = vitalSeverity(vital_name, severity_value);
    });
    root.querySelector("#rhythm-label").textContent = rhythm_override
      ?? (vitals.heart_rate > 100 ? "Sinus tachycardia" : "Sinus rhythm");
  };

  const showResult = () => {
    if (result_shown || !elements.result_modal) return;
    result_shown = true;
    root.querySelector("#result-score").textContent = String(state.score).padStart(3, "0");
    root.querySelector("#result-time").textContent = formatElapsed(state.elapsed_seconds);
    root.querySelector("#result-actions").textContent = state.actions.length;
    elements.result_modal.hidden = false;
    window.requestAnimationFrame(() => elements.result_modal.classList.add("is-visible"));
    root.querySelector("#continue-button").focus();
  };

  const render = () => {
    const vitals = currentVitals();
    const current_status = bound
      ? state.status
      : derivePatientStatus(vitals, state.actions);
    state = { ...state, status: current_status };
    elements.simulator.dataset.status = current_status;
    elements.time.textContent = formatElapsed(state.elapsed_seconds);
    elements.status.className = `status-chip status-chip--${current_status}`;
    elements.status.innerHTML = `<span></span><strong>${current_status}</strong><small>${getStatusCopy(current_status)}</small>`;
    if (elements.patient_state_dot) {
      elements.patient_state_dot.textContent = current_status === "stable" ? "● STABLE" : current_status === "stabilizing" ? "● RESPONDING" : "● HIGH ACUITY";
    }
    if (elements.score) {
      elements.score.textContent = String(state.score).padStart(3, "0");
    }
    if (elements.pause_button) {
      elements.pause_button.innerHTML = state.running ? uiIcon("pause") : uiIcon("play");
      elements.pause_button.setAttribute("aria-label", state.running ? "Pause simulation" : "Resume simulation");
    }
    renderVitals(vitals);
    renderObjectives();
    renderTimeline();
    elements.last_reading.textContent = `Last reading · ${formatElapsed(state.elapsed_seconds)}`;
    scene_controller?.update(current_status, vitals, state.elapsed_seconds);

    root.querySelectorAll("[data-action]").forEach((button) => {
      const complete = state.actions.includes(button.dataset.action);
      button.classList.toggle("is-complete", complete);
      button.setAttribute("aria-pressed", String(complete));
      if (complete) button.querySelector(".action-card__state").innerHTML = uiIcon("check");
    });

    if (!bound && state.completed) {
      const timeout_id = window.setTimeout(() => {
        timers.timeouts.delete(timeout_id);
        showResult();
      }, 600);
      timers.timeouts.add(timeout_id);
    }
  };

  let caption_hide_timeout = null;
  const say = (line) => {
    if (typeof line !== "string" || line.length === 0) {
      throw new Error("line must be a non-empty string.");
    }
    elements.caption.querySelector("p").textContent = `“${line}”`;
    elements.caption.hidden = false;
    elements.caption.classList.remove("is-speaking");
    window.requestAnimationFrame(() => elements.caption.classList.add("is-speaking"));
    if (bound) {
      // The host's case owns the conversation; the caption is a transient
      // subtitle for what was just said, not a parked quote.
      window.clearTimeout(caption_hide_timeout);
      timers.timeouts.delete(caption_hide_timeout);
      caption_hide_timeout = window.setTimeout(() => {
        timers.timeouts.delete(caption_hide_timeout);
        elements.caption.hidden = true;
      }, 8_000);
      timers.timeouts.add(caption_hide_timeout);
    }
  };

  const performAction = (action_id) => {
    const transition = applyClinicalAction(state, action_id);
    state = transition.state;
    const definition = ACTION_DEFINITIONS[action_id];
    say(PATIENT_REPLIES[action_id]);
    elements.live_region.textContent = transition.event.message;
    showToast(transition.duplicate ? `${definition.short_label} already completed` : `${definition.short_label} completed`);
    emit({
      type: "action",
      action_id,
      duplicate: transition.duplicate,
      event: transition.event,
      score: state.score,
      status: state.status,
      completed: state.completed,
    });
    render();
  };

  const on = (selector, handler) => {
    root.querySelectorAll(selector).forEach((element) => element.addEventListener("click", handler));
  };

  on("[data-category]", (event) => setCategory(event.currentTarget.dataset.category));
  on("[data-action]", (event) => performAction(event.currentTarget.dataset.action));
  on("[data-camera]", (event) => {
    root.querySelectorAll("[data-camera]").forEach((camera_button) => camera_button.classList.remove("is-active"));
    event.currentTarget.classList.add("is-active");
    scene_controller?.focusPreset(event.currentTarget.dataset.camera);
  });

  root.querySelector("#begin-button")?.addEventListener("click", () => {
    monitor_audio.enable();
    state = { ...state, running: true };
    elements.brief_modal.classList.add("is-closing");
    const timeout_id = window.setTimeout(() => {
      timers.timeouts.delete(timeout_id);
      elements.brief_modal.hidden = true;
      elements.brief_modal.classList.remove("is-closing");
    }, 420);
    timers.timeouts.add(timeout_id);
    render();
  });
  root.querySelector("#brief-button")?.addEventListener("click", () => {
    elements.brief_modal.hidden = false;
    window.requestAnimationFrame(() => elements.brief_modal.classList.remove("is-closing"));
  });
  elements.pause_button?.addEventListener("click", () => {
    state = { ...state, running: !state.running };
    showToast(state.running ? "Simulation resumed" : "Simulation paused");
    render();
  });
  root.querySelector("#sound-button")?.addEventListener("click", (event) => {
    monitor_audio.enable();
    const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
    event.currentTarget.setAttribute("aria-pressed", String(!pressed));
    monitor_audio.setMuted(!pressed);
    showToast(pressed ? "Audio cues enabled" : "Audio cues muted");
  });
  root.querySelector("#dashboard-button")?.addEventListener("click", (event) => {
    const enabled = !elements.simulator.classList.contains("is-dashboard");
    elements.simulator.classList.toggle("is-dashboard", enabled);
    event.currentTarget.setAttribute("aria-pressed", String(enabled));
    showToast(enabled ? "Simplified dashboard view" : "Interactive 3D view");
  });
  root.querySelector("#settings-button").addEventListener("click", (event) => {
    const enabled = !elements.simulator.classList.contains("is-high-contrast");
    elements.simulator.classList.toggle("is-high-contrast", enabled);
    event.currentTarget.setAttribute("aria-pressed", String(enabled));
    showToast(enabled ? "High contrast enabled" : "High contrast disabled");
  });
  root.querySelector("#timeline-button")?.addEventListener("click", () => {
    timeline_expanded = !timeline_expanded;
    root.querySelector(".activity-panel").classList.toggle("is-expanded", timeline_expanded);
    renderTimeline();
  });
  root.querySelector("#trend-button").addEventListener("click", () => {
    const rows = bound ? sampleTrendRows(bound_history) : deriveVitalTrends(state);
    if (rows.length < 2) {
      showToast("Trends need at least two monitor readings");
      return;
    }
    elements.trends_body.innerHTML = buildTrendsMarkup(rows);
    elements.trends_modal.hidden = false;
    window.requestAnimationFrame(() => elements.trends_modal.classList.add("is-visible"));
    root.querySelector("#trends-close").focus();
  });
  root.querySelector("#trends-close").addEventListener("click", () => {
    closeModal(elements.trends_modal);
  });
  root.querySelector("#records-button")?.addEventListener("click", openRecords);
  root.querySelector("#records-close")?.addEventListener("click", () => closeModal(elements.records_modal));
  elements.treatments_button?.addEventListener("click", openTreatments);
  root.querySelector("#treatments-close")?.addEventListener("click", () => closeModal(elements.treatments_modal));
  elements.treatments_body?.addEventListener("click", (event) => {
    const order_button = event.target.closest?.(".treatment-order");
    if (!order_button) return;
    const treatment = available_treatments[Number(order_button.dataset.orderIndex)];
    if (!treatment) return;
    order_button.disabled = true;
    emit({ type: "order_request", treatment });
    showToast(`${treatment.name} ordered`);
  });
  root.querySelector("#continue-button")?.addEventListener("click", () => {
    elements.result_modal.classList.remove("is-visible");
    const timeout_id = window.setTimeout(() => {
      timers.timeouts.delete(timeout_id);
      elements.result_modal.hidden = true;
    }, 300);
    timers.timeouts.add(timeout_id);
    state = { ...state, completed: false, running: true };
  });
  root.querySelector("#restart-button")?.addEventListener("click", () => {
    state = createSimulation({
      running: true,
      log: [createLogEntry(0, "Scenario restarted.", "system")],
    });
    result_shown = false;
    elements.result_modal.classList.remove("is-visible");
    const timeout_id = window.setTimeout(() => {
      timers.timeouts.delete(timeout_id);
      elements.result_modal.hidden = true;
    }, 300);
    timers.timeouts.add(timeout_id);
    render();
  });

  const handleKeydown = (event) => {
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return;
    const camera_names = ["overview", "patient", "airway", "monitor", "equipment"];
    if (/^[1-5]$/.test(event.key)) {
      root.querySelector(`[data-camera="${camera_names[Number(event.key) - 1]}"]`)?.click();
    }
    if (event.code === "Space" && elements.pause_button && (!elements.brief_modal || elements.brief_modal.hidden)) {
      event.preventDefault();
      elements.pause_button.click();
    }
    if (event.key === "Escape") {
      [elements.trends_modal, elements.records_modal, elements.treatments_modal]
        .filter((modal) => modal && !modal.hidden)
        .forEach((modal) => closeModal(modal));
    }
  };
  document.addEventListener("keydown", handleKeydown);

  if (!bound) {
    timers.intervals.push(window.setInterval(() => {
      state = tickSimulation(state, 1);
      if (state.running) render();
    }, 1000));
  }
  if (waveform === "internal") {
    let wave_phase = 0;
    timers.intervals.push(window.setInterval(() => {
      wave_phase += 0.18;
      elements.ecg_path.setAttribute("d", createWavePath(currentVitals().heart_rate, 640, 96, wave_phase));
    }, 90));
  }
  const heartbeatLoop = () => {
    if (disposed) return;
    const vitals = currentVitals();
    if (state.running) {
      monitor_audio.beat(vitals);
    }
    const timeout_id = window.setTimeout(() => {
      timers.timeouts.delete(timeout_id);
      heartbeatLoop();
    }, Math.round(60_000 / Math.max(vitals.heart_rate, 30)));
    timers.timeouts.add(timeout_id);
  };
  if (!bound) {
    // In bound mode the host's own monitor owns audio; the room has no sound
    // control there and never creates an AudioContext.
    heartbeatLoop();
  }

  render();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      timers.intervals.forEach((interval_id) => window.clearInterval(interval_id));
      timers.timeouts.forEach((timeout_id) => window.clearTimeout(timeout_id));
      window.clearTimeout(toast_timeout);
      document.removeEventListener("keydown", handleKeydown);
      scene_controller?.dispose();
      container.innerHTML = "";
      container.classList.remove("rohy3d-root");
    },
    update(vitals, status, elapsed_seconds, extras = {}) {
      if (!bound) {
        throw new Error("update() is only available in bound mode; the standalone engine derives its own vitals.");
      }
      validateVitals(vitals);
      if (!Number.isFinite(elapsed_seconds) || elapsed_seconds < 0) {
        throw new Error("elapsed_seconds must be a non-negative finite number.");
      }
      if (extras.rhythm !== undefined && extras.rhythm !== null
        && (typeof extras.rhythm !== "string" || extras.rhythm.length === 0)) {
        throw new Error("extras.rhythm must be a non-empty string or null when provided.");
      }
      if (extras.rhythm !== undefined) {
        // A string names the rhythm on the monitor label; null clears the
        // override so the label falls back to the heart-rate-derived text.
        rhythm_override = extras.rhythm;
      }
      // With no action history, derivePatientStatus can never report "stable";
      // grant the escalation criterion so a host that omits status still spans
      // the full range from its numbers alone.
      const next_status = status ?? derivePatientStatus(vitals, ["call_team"]);
      if (!PATIENT_STATUSES.includes(next_status)) {
        throw new Error(`Unknown patient status: ${next_status}`);
      }
      bound_vitals = { ...vitals };
      const status_changed = next_status !== state.status;
      state = { ...state, elapsed_seconds, status: next_status };
      bound_history.push({ time: Math.round(elapsed_seconds), ...bound_vitals });
      if (bound_history.length > 720) {
        bound_history.shift();
      }
      if (status_changed) {
        emit({ type: "status", status: next_status });
      }
      render();
    },
    addTimelineEvent(message, type = "system", time = state.elapsed_seconds) {
      state = { ...state, log: [...state.log, createLogEntry(time, message, type)] };
      elements.live_region.textContent = message;
      renderTimeline();
    },
    say,
    applyAction(action_id) {
      if (bound) {
        throw new Error("applyAction() is only available in standalone mode; the host owns actions in bound mode.");
      }
      performAction(action_id);
    },
    focusPreset(name) {
      root.querySelector(`[data-camera="${name}"]`)?.click();
    },
    getState() {
      return { ...state, actions: [...state.actions], log: [...state.log] };
    },
    openRecords,
    openTreatments,
    setAvailableTreatments(treatments) {
      if (!Array.isArray(treatments)) {
        throw new Error("treatments must be an array.");
      }
      available_treatments = [...treatments];
      renderTreatments();
    },
    setActiveTreatments(treatments) {
      if (!Array.isArray(treatments)) {
        throw new Error("treatments must be an array.");
      }
      active_treatments = [...treatments];
      renderTreatments();
    },
    // Present only with waveform: "host" — the host draws its own ECG here.
    ecg_canvas: root.querySelector("#ecg-canvas"),
  };
}

/**
 * Boot the standalone application into the page's #app element.
 * @return {ReturnType<typeof mountPatientRoom>} Room controller.
 * @example
 * boot();
 */
export function boot() {
  const app = document.querySelector("#app");
  if (!app) {
    throw new Error("#app root was not found.");
  }
  return mountPatientRoom(app);
}

if (typeof document !== "undefined" && document.querySelector("#app")) {
  boot();
}
