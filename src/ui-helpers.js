/**
 * Pure, DOM-free presentation helpers shared by the interface layer.
 * Kept separate from main.js (which imports CSS) so node:test can load them.
 */

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
  // The caller advances phase by 0.18 every 90 ms and the pattern shifts by
  // phase * 30 units, i.e. a fixed 60 units/s sweep. Deriving the R-R spacing
  // as sweep * (60 / HR) makes the on-screen beat rate equal the heart rate
  // (clamped so extreme rates keep a drawable complex).
  const beat_width = Math.min(150, Math.max(24, 3600 / heart_rate));
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
 * Build an SVG polyline path for a vital-sign trend sparkline.
 * @param {number[]} values Sampled vital values, oldest first.
 * @param {number} width SVG width.
 * @param {number} height SVG height.
 * @return {string} SVG path data spanning the full width.
 * @example
 * createTrendPath([86, 88, 93], 180, 40);
 */
export function createTrendPath(values, width, height) {
  if (!Array.isArray(values) || values.length < 2 || !values.every(Number.isFinite)) {
    throw new Error("values must contain at least two finite numbers.");
  }
  if (![width, height].every((size) => Number.isFinite(size) && size > 0)) {
    throw new Error("width and height must be positive finite numbers.");
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum;
  const vertical_padding = height * 0.14;
  const usable_height = height - vertical_padding * 2;
  const points = values.map((value, index) => {
    const x_position = (width * index) / (values.length - 1);
    const normalized = range === 0 ? 0.5 : (value - minimum) / range;
    const y_position = height - vertical_padding - normalized * usable_height;
    return `${index === 0 ? "M" : "L"}${x_position.toFixed(1)},${y_position.toFixed(1)}`;
  });
  return points.join(" ");
}

/**
 * Build the trends modal body from sampled vital history.
 * @param {Array<{heart_rate: number, oxygen_saturation: number, respiratory_rate: number, systolic: number}>} trend_rows
 *   Sampled vital rows, oldest first.
 * @return {string} HTML markup with one sparkline row per tracked vital.
 * @example
 * buildTrendsMarkup(deriveVitalTrends(createSimulation()));
 */
export function buildTrendsMarkup(trend_rows) {
  if (!Array.isArray(trend_rows) || trend_rows.length < 2) {
    throw new Error("trend_rows must contain at least two samples.");
  }
  const series = [
    { key: "heart_rate", label: "HR", unit: "bpm" },
    { key: "oxygen_saturation", label: "SpO₂", unit: "%" },
    { key: "respiratory_rate", label: "RR", unit: "/min" },
    { key: "systolic", label: "SYS", unit: "mmHg" },
  ];
  return series
    .map(({ key, label, unit }) => {
      const values = trend_rows.map((row) => row[key]);
      const current = values[values.length - 1];
      const severity_key = key === "systolic" ? "blood_pressure" : key;
      return `
        <div class="trend-row" data-trend="${key}" data-severity="${vitalSeverity(severity_key, current)}">
          <div class="trend-row__meta">
            <span>${label}</span>
            <strong>${Math.round(current)}</strong>
            <small>${unit}</small>
          </div>
          <svg viewBox="0 0 220 44" preserveAspectRatio="none" role="img" aria-label="${label} trend">
            <path class="trend-line" d="${createTrendPath(values, 220, 44)}"/>
          </svg>
          <div class="trend-row__range">
            <small>min ${Math.round(Math.min(...values))}</small>
            <small>max ${Math.round(Math.max(...values))}</small>
          </div>
        </div>`;
    })
    .join("");
}

/**
 * Build the medical-records modal body.
 * @param {Array<{title: string, entries: Array<{label: string, value: string}>}>} sections
 *   Record sections, e.g. demographics, history, home medications.
 * @return {string} HTML markup with one definition list per section.
 * @example
 * buildRecordsMarkup([{title: "History", entries: [{label: "PMH", value: "Asthma"}]}]);
 */
export function buildRecordsMarkup(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("sections must be a non-empty array.");
  }
  return sections
    .map((section) => {
      if (typeof section?.title !== "string" || !Array.isArray(section.entries)) {
        throw new Error("every section needs a title and an entries array.");
      }
      const rows = section.entries
        .filter((entry) => entry && entry.value !== undefined && entry.value !== null && String(entry.value).length > 0)
        .map((entry) => `<div><dt>${entry.label}</dt><dd>${entry.value}</dd></div>`)
        .join("");
      return `
        <section class="records-section">
          <h3>${section.title}</h3>
          <dl class="records-list">${rows || '<div><dt></dt><dd class="records-empty">Not recorded</dd></div>'}</dl>
        </section>`;
    })
    .join("");
}

/**
 * Build the treatments modal body: active orders first, then orderables.
 * @param {Array<{name: string, detail?: string, status?: string}>} active Current orders.
 * @param {Array<{name: string, detail?: string}>} available Orderable treatments.
 * @return {string} HTML markup; order buttons carry data-order-index.
 * @example
 * buildTreatmentsMarkup([], [{name: "Salbutamol", detail: "2.5 mg NEB"}]);
 */
export function buildTreatmentsMarkup(active, available) {
  if (!Array.isArray(active) || !Array.isArray(available)) {
    throw new Error("active and available must be arrays.");
  }
  const active_rows = active
    .map((order) => `
      <div class="treatment-row treatment-row--${order.status === "administered" ? "administered" : "ordered"}">
        <div><strong>${order.name}</strong><small>${order.detail ?? ""}</small></div>
        <span class="treatment-status">${order.status ?? "ordered"}</span>
      </div>`)
    .join("");
  const available_rows = available
    .map((treatment, index) => `
      <div class="treatment-row">
        <div><strong>${treatment.name}</strong><small>${treatment.detail ?? ""}</small></div>
        <button type="button" class="treatment-order" data-order-index="${index}">Order</button>
      </div>`)
    .join("");
  return `
    <section class="treatments-section">
      <h3>Active treatment</h3>
      ${active_rows || '<p class="records-empty">No active treatment.</p>'}
    </section>
    <section class="treatments-section">
      <h3>Order treatment</h3>
      <div class="treatments-available">${available_rows || '<p class="records-empty">No treatments available.</p>'}</div>
    </section>`;
}

/**
 * Escape a string for safe interpolation into HTML text or attribute values.
 * @param {unknown} value Host-supplied text.
 * @return {string} Escaped string.
 * @example
 * escapeHtml('S1 & S2 <normal>');
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Compute wedge geometry for a radial wheel: clip-path polygons, rim arcs,
 * and label/tick anchor points shared by the view wheel and the exam wheel.
 * @param {number} count Number of wedges (2–8); the first wedge is centered
 *   at 12 o'clock and wedges proceed clockwise.
 * @return {Array<{polygon: string, rim_d: string, label_left: string, label_top: string, tick_left: string, tick_top: string}>}
 *   One geometry entry per wedge; polygon and anchors are percentage strings
 *   for a 300x300 wheel, rim_d is an SVG arc path.
 * @example
 * radialWedgeGeometry(4);
 */
export function radialWedgeGeometry(count) {
  if (!Number.isInteger(count) || count < 2 || count > 8) {
    throw new Error("count must be an integer of 2 to 8 wedges.");
  }
  const size = 300;
  const center = size / 2;
  const outer_radius = 147;
  const inner_radius = 60;
  const rim_radius = 141;
  const sector = 360 / count;
  const gap_degrees = 2.2;
  const to_radians = (degrees) => (degrees * Math.PI) / 180;
  const point = (radius, degrees) => [
    center + radius * Math.cos(to_radians(degrees)),
    center + radius * Math.sin(to_radians(degrees)),
  ];
  const percent = (value) => `${((value / size) * 100).toFixed(2)}%`;

  return Array.from({ length: count }, (_, index) => {
    const start = -90 - sector / 2 + index * sector + gap_degrees;
    const end = start + sector - gap_degrees * 2;
    const arc_samples = 8;
    const outer_points = Array.from({ length: arc_samples + 1 }, (_, i) => {
      return point(outer_radius, start + ((end - start) * i) / arc_samples);
    });
    const inner_points = Array.from({ length: arc_samples + 1 }, (_, i) => {
      return point(inner_radius, end - ((end - start) * i) / arc_samples);
    });
    const polygon = [...outer_points, ...inner_points]
      .map(([x, y]) => `${percent(x)} ${percent(y)}`)
      .join(", ");
    const [rim_start_x, rim_start_y] = point(rim_radius, start);
    const [rim_end_x, rim_end_y] = point(rim_radius, end);
    const middle = (start + end) / 2;
    const [label_x, label_y] = point((outer_radius + inner_radius) / 2 + 6, middle);
    // Outward of the label block (radius 109.5 + ~14px half-height) with
    // clearance so the done tick never overlaps a wedge's hint line.
    const [tick_x, tick_y] = point(outer_radius - 13, middle);
    return {
      polygon,
      rim_d: `M ${rim_start_x.toFixed(1)} ${rim_start_y.toFixed(1)} A ${rim_radius} ${rim_radius} 0 0 1 ${rim_end_x.toFixed(1)} ${rim_end_y.toFixed(1)}`,
      label_left: percent(label_x),
      label_top: percent(label_y),
      tick_left: percent(tick_x),
      tick_top: percent(tick_y),
    };
  });
}

/**
 * Build a radial view-wheel: donut wedges around a central hub, one per
 * camera view, each with a colored rim arc, a label, and a hint. Wedges are
 * real <button data-camera> elements (wedge-shaped via clip-path), so
 * existing delegation and keyboard shortcuts keep working.
 * @param {Array<{id: string, label: string, hint: string, color: string}>} views
 *   Camera views; the first wedge is centered at the top. The hub steps
 *   through these, because a view is a state you can cycle.
 * @param {Array<{id: string, label: string, hint: string, color: string}>} [actions]
 *   Destinations that are not camera moves — examine, records, the body
 *   map. They sit on the same wheel but are one-shot: the hub never steps
 *   onto them, they are chosen deliberately. Views + actions ≤ 8.
 * @return {string} HTML markup for the wheel's rims, wedges, and hub.
 * @example
 * buildViewWheelMarkup([{id: "overview", label: "Overview", hint: "Whole room", color: "#5aa9ff"}, ...]);
 */
export function buildViewWheelMarkup(views, actions = []) {
  if (!Array.isArray(views) || views.length < 3) {
    throw new Error("views must be an array of at least 3 entries.");
  }
  if (!Array.isArray(actions)) {
    throw new Error("actions must be an array when provided.");
  }
  const entries = [...views, ...actions];
  if (entries.length > 8) {
    throw new Error("views and actions must total 8 wedges or fewer.");
  }
  entries.forEach((entry) => {
    if ([entry?.id, entry?.label, entry?.hint, entry?.color].some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("every wedge needs id, label, hint, and color strings.");
    }
  });

  const geometry = radialWedgeGeometry(entries.length);
  const rim_paths = entries.map((entry, index) => {
    return `<path data-for="${escapeHtml(entry.id)}" d="${geometry[index].rim_d}" stroke="${entry.color}"/>`;
  });
  const wedges = entries.map((entry, index) => {
    const is_view = index < views.length;
    const target = is_view ? `data-camera="${escapeHtml(entry.id)}"` : `data-nav="${escapeHtml(entry.id)}"`;
    return `
      <button type="button" class="view-wheel__wedge${index === 0 ? " is-active" : ""}${is_view ? "" : " view-wheel__wedge--action"}" ${target}
        style="--wedge-color: ${entry.color}; clip-path: polygon(${geometry[index].polygon});">
        <span class="view-wheel__copy" style="left: ${geometry[index].label_left}; top: ${geometry[index].label_top};">
          <strong>${escapeHtml(entry.label)}</strong>
          <small>${escapeHtml(entry.hint)}</small>
        </span>
      </button>`;
  });

  return `
    <svg class="view-wheel__rims" viewBox="0 0 300 300" aria-hidden="true">${rim_paths.join("")}</svg>
    ${wedges.join("")}
    <button type="button" class="view-wheel__hub" id="view-wheel-hub" aria-expanded="false"
      aria-label="Next camera view: ${views[1 % views.length].label}">
      <small>VIEW</small>
      <strong id="view-wheel-label">${views[0].label}</strong>
      <span class="view-wheel__hub-next" id="view-wheel-next">${views[1 % views.length].label} \u203a</span>
    </button>`;
}

/** Canonical clinical ordering for examination techniques on the exam wheel. */
export const EXAM_TECHNIQUE_ORDER = Object.freeze([
  "inspection",
  "palpation",
  "percussion",
  "auscultation",
  "special",
]);

/**
 * Sort a region's examination techniques into the canonical clinical order
 * (inspect, palpate, percuss, auscultate, special); techniques outside the
 * canon keep their given relative order after the canonical ones.
 * @param {Array<{id: string}>} exams Region examination definitions.
 * @return {Array<object>} Sorted copy.
 * @example
 * orderExamItems([{id: "auscultation"}, {id: "inspection"}]);
 */
export function orderExamItems(exams) {
  if (!Array.isArray(exams)) {
    throw new Error("exams must be an array.");
  }
  const rank = (exam) => {
    const index = EXAM_TECHNIQUE_ORDER.indexOf(exam.id);
    return index === -1 ? EXAM_TECHNIQUE_ORDER.length : index;
  };
  return exams
    .map((exam, index) => ({ exam, index }))
    .sort((a, b) => rank(a.exam) - rank(b.exam) || a.index - b.index)
    .map(({ exam }) => exam);
}

/**
 * Derive the exam wheel's main-ring wedge items from a region's exams.
 * A "special" technique with exactly one named test flattens onto the main
 * ring as that test (one click instead of a one-item sub-ring); with two or
 * more tests it keeps a count badge and opens the sub-ring.
 * @param {Array<{id: string, label: string, hint?: string, tests?: string[]}>} exams
 *   Region examination definitions.
 * @param {Record<string, "examined"|"abnormal">} [performed] Done-state per
 *   technique id, from the room's exam log.
 * @return {Array<{id: string, label: string, hint: string, tests: string[], test: string|null, badge: number|null, done: string|null}>}
 *   Wedge items in canonical order.
 * @example
 * examWheelItems([{id: "special", label: "Special", tests: ["Pupil reflex"]}]);
 */
export function examWheelItems(exams, performed = {}) {
  if (!Array.isArray(exams) || exams.length === 0) {
    throw new Error("exams must be a non-empty array.");
  }
  return orderExamItems(exams).map((exam) => {
    const tests = Array.isArray(exam.tests) ? exam.tests : [];
    const flattened = exam.id === "special" && tests.length === 1;
    return {
      id: exam.id,
      label: flattened ? tests[0] : exam.label,
      hint: flattened ? "Special test" : exam.hint ?? "",
      tests,
      test: flattened ? tests[0] : null,
      badge: exam.id === "special" && tests.length > 1 ? tests.length : null,
      done: performed[exam.id] ?? null,
    };
  });
}

/**
 * Derive the special-tests sub-ring wedge items: named tests clockwise from
 * 12 o'clock with a Back wedge pinned as close to 6 o'clock as the wedge
 * count allows.
 * @param {string[]} tests Named special tests (2–7).
 * @param {Record<string, "examined"|"abnormal">} [performed] Done-state per
 *   test name, from the room's exam log.
 * @return {Array<{id: string, label: string, hint: string, test: string|null, back: boolean, done: string|null}>}
 *   Wedge items including the Back wedge.
 * @example
 * examSubRingItems(["Pupil reflex", "Fundoscopy"]);
 */
export function examSubRingItems(tests, performed = {}) {
  if (!Array.isArray(tests) || tests.length < 2 || tests.length > 7
    || tests.some((test) => typeof test !== "string" || test.length === 0)) {
    throw new Error("tests must be 2 to 7 non-empty strings.");
  }
  const items = tests.map((test) => ({
    id: "special",
    label: test,
    hint: "Special test",
    test,
    back: false,
    done: performed[test] ?? null,
  }));
  const back = { id: "back", label: "Back", hint: "Techniques", test: null, back: true, done: null };
  // With the first wedge centered at 12 o'clock, index round(count/2) sits
  // nearest 6 o'clock — the conventional "retreat" position.
  items.splice(Math.round((tests.length + 1) / 2), 0, back);
  return items;
}

/**
 * Clamp a requested wheel center so the whole wheel stays inside the stage.
 * @param {number} x Requested center x, in stage pixels.
 * @param {number} y Requested center y, in stage pixels.
 * @param {number} width Stage width.
 * @param {number} height Stage height.
 * @param {number} [margin] Minimum distance from center to any stage edge.
 * @return {{x: number, y: number}} Clamped center.
 * @example
 * clampWheelCenter(10, 10, 1280, 720);
 */
export function clampWheelCenter(x, y, width, height, margin = 166) {
  if (![x, y, width, height, margin].every(Number.isFinite)) {
    throw new Error("clampWheelCenter needs finite numbers.");
  }
  // A stage smaller than the wheel centers it on the shorter axis.
  const clamp = (value, extent) => (extent <= margin * 2
    ? extent / 2
    : Math.min(Math.max(value, margin), extent - margin));
  return { x: clamp(x, width), y: clamp(y, height) };
}

/**
 * Build the exam wheel's rims, wedges, and hub for one ring.
 * Wedges are real <button data-exam> elements; a sub-ring's Back wedge
 * carries data-back, and a flattened or sub-ring test wedge carries
 * data-test with the test's name.
 * @param {string} region_label Region name shown in the hub.
 * @param {Array<object>} items Wedge items from examWheelItems or examSubRingItems,
 *   each given a color and optional icon markup by the caller.
 * @param {{ring?: "main"|"special", next_label?: string|null}} [options]
 *   Which ring is rendered, and the region the hub steps to next.
 * @return {string} HTML markup for the wheel's rims, wedges, and hub.
 * @example
 * buildExamWheelMarkup("Chest", [{id: "palpation", label: "Palpate", hint: "Feel", color: "#2ae0bd"}]);
 */
export function buildExamWheelMarkup(region_label, items, options = {}) {
  if (typeof region_label !== "string" || region_label.length === 0) {
    throw new Error("region_label must be a non-empty string.");
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
    throw new Error("items must be an array of 1 to 8 wedges.");
  }
  const ring = options.ring ?? "main";
  const next_label = options.next_label ?? null;
  if (!["main", "special"].includes(ring)) {
    throw new Error(`Unknown exam wheel ring: ${ring}`);
  }
  items.forEach((item) => {
    if ([item?.id, item?.label, item?.color].some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("every wedge needs id, label, and color strings.");
    }
  });

  // A single wedge (a lone flattened special test) still renders as a ring
  // of two half-wedges would — geometry needs at least 2 sectors.
  const geometry = radialWedgeGeometry(Math.max(items.length, 2)).slice(0, items.length);
  const show_hints = items.length <= 5;
  const rim_paths = items.map((item, index) => {
    return `<path data-for="${escapeHtml(item.id)}" d="${geometry[index].rim_d}" stroke="${item.color}"/>`;
  });
  const wedges = items.map((item, index) => {
    const done = item.done ? ` is-done` : "";
    const back = item.back ? " exam-wheel__wedge--back" : "";
    const test_attr = item.test ? ` data-test="${escapeHtml(item.test)}"` : "";
    const back_attr = item.back ? ' data-back="true"' : "";
    return `
      <button type="button" class="exam-wheel__wedge${done}${back}" data-exam="${escapeHtml(item.id)}"${test_attr}${back_attr}
        style="--wedge-color: ${item.color}; --wedge-index: ${index}; clip-path: polygon(${geometry[index].polygon});">
        <span class="exam-wheel__copy" style="left: ${geometry[index].label_left}; top: ${geometry[index].label_top};">
          ${item.icon ? `<i class="exam-wheel__glyph" aria-hidden="true">${item.icon}</i>` : ""}
          <strong>${escapeHtml(item.label)}</strong>
          ${show_hints && item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}
          ${item.badge ? `<b class="exam-wheel__badge">${item.badge}</b>` : ""}
        </span>
        ${item.done ? `<span class="exam-wheel__done exam-wheel__done--${item.done}" style="left: ${geometry[index].tick_left}; top: ${geometry[index].tick_top};" aria-hidden="true">✓</span><span class="sr-only">, performed${item.done === "abnormal" ? ", abnormal finding" : ""}</span>` : ""}
      </button>`;
  });

  return `
    <svg class="exam-wheel__rims" viewBox="0 0 300 300" aria-hidden="true">${rim_paths.join("")}</svg>
    ${wedges.join("")}
    <button type="button" class="exam-wheel__hub" id="exam-wheel-hub"
      aria-label="${ring === "special"
        ? `Back to examination techniques for ${escapeHtml(region_label)}`
        : next_label
          ? `Examine the next region: ${escapeHtml(next_label)}`
          : `Close examination of ${escapeHtml(region_label)}`}">
      <small>${ring === "special" ? "SPECIAL TESTS" : "EXAMINE"}</small>
      <strong>${escapeHtml(region_label)}</strong>
      ${ring === "special" || !next_label
        ? ""
        : `<span class="exam-wheel__hub-next">${escapeHtml(next_label)} \u203a</span>`}
    </button>`;
}

/**
 * Build the finding card's inner markup: kicker, severity flag, clinical
 * finding text, and optional audio chips.
 * @param {{
 *   region_label: string,
 *   exam_label: string,
 *   finding?: string,
 *   abnormal?: boolean,
 *   audio?: Array<{label: string, url: string}>,
 *   error?: string,
 * }} result One examination's presentation data; error renders an
 *   examination-failed card instead of a finding.
 * @return {string} HTML markup for the card's interior.
 * @example
 * buildFindingCardMarkup({region_label: "Chest", exam_label: "Auscultation", finding: "Vesicular breath sounds.", abnormal: false});
 */
export function buildFindingCardMarkup(result) {
  if (typeof result?.region_label !== "string" || result.region_label.length === 0
    || typeof result.exam_label !== "string" || result.exam_label.length === 0) {
    throw new Error("result needs region_label and exam_label strings.");
  }
  if (result.error === undefined && (typeof result.finding !== "string" || result.finding.length === 0)) {
    throw new Error("result needs a non-empty finding unless it is an error card.");
  }
  const audio = result.audio ?? [];
  if (!Array.isArray(audio) || audio.some((track) => typeof track?.label !== "string" || typeof track?.url !== "string")) {
    throw new Error("result.audio must be an array of {label, url}.");
  }
  const chips = audio
    .map((track, index) => `
      <button type="button" class="audio-chip" data-audio-index="${index}" data-audio-url="${escapeHtml(track.url)}">
        <span class="audio-chip__glyph" aria-hidden="true"></span>
        <span class="audio-chip__bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span class="audio-chip__label">${escapeHtml(track.label)}</span>
      </button>`)
    .join("");
  return `
    <span class="finding-card__accent" aria-hidden="true"></span>
    <header class="finding-card__header">
      <span class="finding-card__kicker"><i aria-hidden="true"></i><span class="finding-card__kicker-text">${escapeHtml(result.region_label)} · ${escapeHtml(result.exam_label)}</span></span>
      ${result.abnormal ? '<span class="finding-card__flag">▲ Abnormal</span>' : ""}
      <button type="button" class="finding-card__close" id="finding-close" aria-label="Close finding">✕</button>
    </header>
    <div class="finding-card__body" aria-live="polite" tabindex="0">
      ${result.error !== undefined
        ? `<p class="finding-card__error">${escapeHtml(result.error)}</p>`
        : `<p>${escapeHtml(result.finding)}</p>`}
    </div>
    ${chips ? `<div class="finding-card__audio">${chips}</div>` : ""}`;
}

/**
 * Evenly downsample recorded vitals rows for the trends view.
 * @param {Array<object>} rows Recorded rows, oldest first.
 * @param {number} [maximum] Maximum rows to keep (>= 2).
 * @return {Array<object>} Sampled rows, always including the first and last.
 * @example
 * sampleTrendRows([{time: 0}, {time: 1}, {time: 2}], 2);
 */
export function sampleTrendRows(rows, maximum = 13) {
  if (!Array.isArray(rows)) {
    throw new Error("rows must be an array.");
  }
  if (!Number.isInteger(maximum) || maximum < 2) {
    throw new Error("maximum must be an integer of at least 2.");
  }
  if (rows.length <= maximum) {
    return [...rows];
  }
  return Array.from({ length: maximum }, (_, index) => {
    return rows[Math.round(((rows.length - 1) * index) / (maximum - 1))];
  });
}

/**
 * Map oxygen saturation to a pulse-beep pitch, mimicking a bedside monitor
 * whose tone falls as the patient desaturates.
 * @param {number} oxygen_saturation SpO2 percentage.
 * @return {number} Beep frequency in Hz.
 * @example
 * beepFrequencyForSpo2(97);
 */
export function beepFrequencyForSpo2(oxygen_saturation) {
  if (!Number.isFinite(oxygen_saturation)) {
    throw new Error("oxygen_saturation must be a finite number.");
  }
  const clamped = Math.min(Math.max(oxygen_saturation, 60), 100);
  return Math.round(440 + (clamped - 60) * 11);
}
