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
 * Build a radial view-wheel: donut wedges around a central hub, one per
 * camera view, each with a colored rim arc, a label, and a hint. Wedges are
 * real <button data-camera> elements (wedge-shaped via clip-path), so
 * existing delegation and keyboard shortcuts keep working.
 * @param {Array<{id: string, label: string, hint: string, color: string}>} views
 *   3–8 views; the first wedge is centered at the top.
 * @return {string} HTML markup for the wheel's rims, wedges, and hub.
 * @example
 * buildViewWheelMarkup([{id: "overview", label: "Overview", hint: "Whole room", color: "#5aa9ff"}, ...]);
 */
export function buildViewWheelMarkup(views) {
  if (!Array.isArray(views) || views.length < 3 || views.length > 8) {
    throw new Error("views must be an array of 3 to 8 entries.");
  }
  views.forEach((view) => {
    if ([view?.id, view?.label, view?.hint, view?.color].some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("every view needs id, label, hint, and color strings.");
    }
  });

  const size = 300;
  const center = size / 2;
  const outer_radius = 147;
  const inner_radius = 60;
  const rim_radius = 141;
  const sector = 360 / views.length;
  const gap_degrees = 2.2;
  const to_radians = (degrees) => (degrees * Math.PI) / 180;
  const point = (radius, degrees) => [
    center + radius * Math.cos(to_radians(degrees)),
    center + radius * Math.sin(to_radians(degrees)),
  ];
  const percent = (value) => `${((value / size) * 100).toFixed(2)}%`;

  const rim_paths = [];
  const wedges = views.map((view, index) => {
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
    rim_paths.push(`<path data-for="${view.id}" d="M ${rim_start_x.toFixed(1)} ${rim_start_y.toFixed(1)} A ${rim_radius} ${rim_radius} 0 0 1 ${rim_end_x.toFixed(1)} ${rim_end_y.toFixed(1)}" stroke="${view.color}"/>`);

    const label_radius = (outer_radius + inner_radius) / 2 + 6;
    const [label_x, label_y] = point(label_radius, (start + end) / 2);
    return `
      <button type="button" class="view-wheel__wedge${index === 0 ? " is-active" : ""}" data-camera="${view.id}"
        style="--wedge-color: ${view.color}; clip-path: polygon(${polygon});">
        <span class="view-wheel__copy" style="left: ${percent(label_x)}; top: ${percent(label_y)};">
          <strong>${view.label}</strong>
          <small>${view.hint}</small>
        </span>
      </button>`;
  });

  return `
    <svg class="view-wheel__rims" viewBox="0 0 ${size} ${size}" aria-hidden="true">${rim_paths.join("")}</svg>
    ${wedges.join("")}
    <button type="button" class="view-wheel__hub" id="view-wheel-hub" aria-expanded="false" aria-label="Choose camera view">
      <small>VIEW</small>
      <strong id="view-wheel-label">${views[0].label}</strong>
    </button>`;
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
