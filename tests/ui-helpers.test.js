import test from "node:test";
import assert from "node:assert/strict";

import {
  beepFrequencyForSpo2,
  buildRecordsMarkup,
  buildTreatmentsMarkup,
  buildTrendsMarkup,
  buildViewWheelMarkup,
  createTrendPath,
  createWavePath,
  formatElapsed,
  getStatusCopy,
  sampleTrendRows,
  vitalSeverity,
} from "../src/ui-helpers.js";

test("formatElapsed renders MM:SS and validates input", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(65), "01:05");
  assert.equal(formatElapsed(3599.9), "59:59");
  [-1, Number.NaN, Number.POSITIVE_INFINITY, "10"].forEach((seconds) => {
    assert.throws(() => formatElapsed(seconds), /non-negative finite number/);
  });
});

test("vitalSeverity classifies each tracked vital and rejects unknown names", () => {
  assert.equal(vitalSeverity("heart_rate", 80), "normal");
  assert.equal(vitalSeverity("heart_rate", 110), "warning");
  assert.equal(vitalSeverity("heart_rate", 130), "critical");
  assert.equal(vitalSeverity("oxygen_saturation", 86), "critical");
  assert.equal(vitalSeverity("oxygen_saturation", 92), "warning");
  assert.equal(vitalSeverity("oxygen_saturation", 97), "normal");
  assert.equal(vitalSeverity("respiratory_rate", 32), "critical");
  assert.equal(vitalSeverity("blood_pressure", 168), "warning");
  assert.equal(vitalSeverity("temperature", 37.8), "warning");
  assert.throws(() => vitalSeverity("lactate", 2), /Unknown vital name/);
  assert.throws(() => vitalSeverity("heart_rate", Number.NaN), /must be numeric/);
});

test("getStatusCopy covers every patient status and rejects unknown ones", () => {
  ["critical", "unstable", "stabilizing", "stable"].forEach((status) => {
    assert.equal(typeof getStatusCopy(status), "string");
    assert.ok(getStatusCopy(status).length > 0);
  });
  assert.throws(() => getStatusCopy("deceased"), /Unknown patient status/);
});

test("createWavePath emits a bounded SVG path and validates input", () => {
  const path = createWavePath(116, 640, 96, 0);
  assert.match(path, /^M0\.0,/);
  const y_values = [...path.matchAll(/,(-?\d+\.\d)/g)].map((match) => Number(match[1]));
  assert.ok(y_values.length > 100);
  y_values.forEach((y_value) => {
    assert.ok(y_value >= -20 && y_value <= 116, `waveform y ${y_value} escaped the viewbox`);
  });
  assert.throws(() => createWavePath(0, 640, 96, 0), /positive finite/);
  assert.throws(() => createWavePath(80, -1, 96, 0), /positive finite/);
});

test("createWavePath beat spacing tracks the heart rate (beats/s = HR/60)", () => {
  // The UI sweeps the pattern at a fixed 60 units/s, so an on-screen beat
  // rate equal to the heart rate requires an R-R spacing of 3600/HR units.
  // Verify the drawn pattern is periodic at exactly that spacing (after
  // removing the non-periodic baseline wobble), for rates whose spacing
  // lands on the 3-unit sampling grid.
  [60, 100, 120, 150].forEach((heart_rate) => {
    const expected_period = 3600 / heart_rate;
    const path = createWavePath(heart_rate, 640, 96, 0);
    const y_values = [...path.matchAll(/,(-?\d+\.\d)/g)].map((match) => Number(match[1]));
    const detrended = y_values.map((y, index) => y - Math.sin(index * 3 * 0.06) * 1.4);
    const offset = expected_period / 3;
    detrended.slice(0, detrended.length - offset).forEach((value, index) => {
      assert.ok(
        Math.abs(value - detrended[index + offset]) <= 0.15,
        `HR ${heart_rate}: pattern must repeat every ${expected_period} units (index ${index})`,
      );
    });
    // Sanity: the same tolerance must fail at a wrong period, so the
    // periodicity assertion above cannot pass vacuously.
    const wrong_offset = Math.round(offset * 1.5);
    const mismatch = detrended
      .slice(0, detrended.length - wrong_offset)
      .some((value, index) => Math.abs(value - detrended[index + wrong_offset]) > 0.15);
    assert.ok(mismatch, `HR ${heart_rate}: a wrong period must not appear periodic`);
  });
});

test("createTrendPath spans the width, stays inside the height, and validates input", () => {
  const path = createTrendPath([86, 88, 84, 93], 220, 44);
  const coordinates = [...path.matchAll(/([ML])(-?\d+\.\d),(-?\d+\.\d)/g)]
    .map((match) => ({ x: Number(match[2]), y: Number(match[3]) }));
  assert.equal(coordinates.length, 4);
  assert.equal(coordinates[0].x, 0);
  assert.equal(coordinates[coordinates.length - 1].x, 220);
  coordinates.forEach(({ y }) => assert.ok(y >= 0 && y <= 44));
  const minimum_y = Math.min(...coordinates.map(({ y }) => y));
  const maximum_y = Math.max(...coordinates.map(({ y }) => y));
  assert.equal(coordinates[3].y, minimum_y, "the highest value should sit highest in the SVG");
  assert.equal(coordinates[2].y, maximum_y, "the lowest value should sit lowest in the SVG");

  const flat_path = createTrendPath([90, 90, 90], 220, 44);
  const flat_y = [...flat_path.matchAll(/,(-?\d+\.\d)/g)].map((match) => Number(match[1]));
  assert.ok(new Set(flat_y).size === 1, "a constant series should draw a level line");

  assert.throws(() => createTrendPath([1], 220, 44), /at least two finite numbers/);
  assert.throws(() => createTrendPath([1, Number.NaN], 220, 44), /at least two finite numbers/);
  assert.throws(() => createTrendPath([1, 2], 0, 44), /positive finite/);
});

test("beepFrequencyForSpo2 falls with desaturation and clamps to the vital range", () => {
  const healthy = beepFrequencyForSpo2(100);
  const desaturated = beepFrequencyForSpo2(80);
  const floor = beepFrequencyForSpo2(60);
  assert.ok(healthy > desaturated && desaturated > floor, "pitch must fall with SpO2");
  assert.equal(beepFrequencyForSpo2(120), healthy, "values above 100 clamp to 100");
  assert.equal(beepFrequencyForSpo2(0), floor, "values below 60 clamp to 60");
  assert.throws(() => beepFrequencyForSpo2(Number.NaN), /finite number/);
});

test("buildTrendsMarkup renders one severity-tagged sparkline row per tracked vital", () => {
  const rows = [
    { time: 0, heart_rate: 116, oxygen_saturation: 86, respiratory_rate: 30, systolic: 168 },
    { time: 8, heart_rate: 112, oxygen_saturation: 88, respiratory_rate: 28, systolic: 168 },
    { time: 16, heart_rate: 98, oxygen_saturation: 93, respiratory_rate: 25, systolic: 168 },
  ];
  const markup = buildTrendsMarkup(rows);
  ["heart_rate", "oxygen_saturation", "respiratory_rate", "systolic"].forEach((key) => {
    assert.match(markup, new RegExp(`data-trend="${key}"`));
  });
  assert.equal([...markup.matchAll(/class="trend-line"/g)].length, 4);
  assert.match(markup, /data-trend="oxygen_saturation" data-severity="warning"/);
  assert.match(markup, /min 86/);
  assert.match(markup, /max 93/);
  assert.throws(() => buildTrendsMarkup([rows[0]]), /at least two samples/);
  assert.throws(() => buildTrendsMarkup("rows"), /at least two samples/);
});

test("sampleTrendRows keeps endpoints, preserves order, and validates input", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ time: index }));
  const sampled = sampleTrendRows(rows, 13);
  assert.equal(sampled.length, 13);
  assert.equal(sampled[0].time, 0);
  assert.equal(sampled[sampled.length - 1].time, 99);
  sampled.slice(1).forEach((row, index) => {
    assert.ok(row.time > sampled[index].time, "sampled rows must stay in order");
  });

  const short_rows = [{ time: 0 }, { time: 1 }];
  const untouched = sampleTrendRows(short_rows, 13);
  assert.deepEqual(untouched, short_rows);
  assert.notStrictEqual(untouched, short_rows, "a copy must be returned");

  assert.throws(() => sampleTrendRows("rows"), /rows must be an array/);
  [1, 0, 2.5, "4"].forEach((maximum) => {
    assert.throws(() => sampleTrendRows(rows, maximum), /integer of at least 2/);
  });
});

test("buildRecordsMarkup renders sections, drops empty values, and validates input", () => {
  const markup = buildRecordsMarkup([
    {
      title: "History",
      entries: [
        { label: "Chief complaint", value: "Crushing chest pain" },
        { label: "PMH", value: "" },
        { label: "Allergies", value: "Sulfa drugs (rash)" },
      ],
    },
    { title: "Home medications", entries: [] },
  ]);
  assert.match(markup, /<h3>History<\/h3>/);
  assert.match(markup, /<dt>Chief complaint<\/dt><dd>Crushing chest pain<\/dd>/);
  assert.doesNotMatch(markup, /<dt>PMH<\/dt>/, "empty values are dropped, not shown blank");
  assert.match(markup, /Not recorded/, "an empty section states its emptiness");
  assert.throws(() => buildRecordsMarkup([]), /non-empty array/);
  assert.throws(() => buildRecordsMarkup([{ entries: [] }]), /title and an entries array/);
});

test("buildTreatmentsMarkup lists active orders and indexed order buttons", () => {
  const markup = buildTreatmentsMarkup(
    [{ name: "Oxygen 2 L/min", detail: "Nasal cannula · 00:04", status: "administered" }],
    [
      { name: "Salbutamol", detail: "NEB · 2.5 mg" },
      { name: "Normal saline", detail: "IV · 500 ml" },
    ],
  );
  assert.match(markup, /Oxygen 2 L\/min/);
  assert.match(markup, /treatment-row--administered/);
  assert.match(markup, /data-order-index="0"/);
  assert.match(markup, /data-order-index="1"/);
  const empty = buildTreatmentsMarkup([], []);
  assert.match(empty, /No active treatment\./);
  assert.match(empty, /No treatments available\./);
  assert.throws(() => buildTreatmentsMarkup(null, []), /must be arrays/);
});

test("buildViewWheelMarkup renders wedge buttons, rims, hub, and validates input", () => {
  const views = [
    { id: "overview", label: "Overview", hint: "Whole room", color: "#5aa9ff" },
    { id: "patient", label: "Patient", hint: "Bedside close-up", color: "#2ae0bd" },
    { id: "airway", label: "Airway", hint: "Head & airway", color: "#b18cff" },
    { id: "monitor", label: "Monitor", hint: "Vitals screen", color: "#ffb84a" },
    { id: "equipment", label: "Equipment", hint: "O\u2082 \u00b7 IV side", color: "#4ecbe0" },
  ];
  const markup = buildViewWheelMarkup(views);

  views.forEach((view) => {
    assert.match(markup, new RegExp(`data-camera="${view.id}"`));
    assert.match(markup, new RegExp(`data-for="${view.id}"`));
    assert.match(markup, new RegExp(`--wedge-color: ${view.color}`));
    assert.match(markup, new RegExp(`<strong>${view.label.replace("\u00b7", ".")}</strong>`));
  });
  assert.equal([...markup.matchAll(/view-wheel__wedge/g)].length, 5);
  assert.equal([...markup.matchAll(/clip-path: polygon\(/g)].length, 5);
  assert.match(markup, /view-wheel__wedge is-active" data-camera="overview"/);
  assert.match(markup, /id="view-wheel-hub"/);
  assert.match(markup, /id="view-wheel-label">Overview</);
  // Every polygon vertex must stay inside the wheel box.
  [...markup.matchAll(/polygon\(([^)]+)\)/g)].forEach((match) => {
    match[1].split(",").forEach((pair) => {
      pair.trim().split(" ").forEach((coordinate) => {
        const value = Number(coordinate.replace("%", ""));
        assert.ok(value >= -0.5 && value <= 100.5, `vertex ${coordinate} escapes the wheel`);
      });
    });
  });

  assert.throws(() => buildViewWheelMarkup(views.slice(0, 2)), /at least 3 entries/);
  assert.throws(() => buildViewWheelMarkup([...views.slice(0, 3), { id: "x", label: "X", hint: "", color: "#fff" }]), /id, label, hint, and color/);
});

test("buildViewWheelMarkup makes the hub a stepper that names the next view", () => {
  const views = [
    { id: "overview", label: "Overview", hint: "Whole room", color: "#5aa9ff" },
    { id: "patient", label: "Patient", hint: "Bedside", color: "#2ae0bd" },
    { id: "airway", label: "Airway", hint: "Head", color: "#b18cff" },
  ];
  const markup = buildViewWheelMarkup(views);
  assert.match(markup, /aria-label="Next camera view: Patient"/);
  assert.match(markup, /id="view-wheel-next">Patient/);
  // The hub shows the CURRENT view large and the next one small.
  assert.match(markup, /id="view-wheel-label">Overview</);
});

test("buildViewWheelMarkup carries destinations beside the camera views", () => {
  const views = [
    { id: "overview", label: "Overview", hint: "Whole room", color: "#5aa9ff" },
    { id: "patient", label: "Patient", hint: "Bedside", color: "#2ae0bd" },
    { id: "airway", label: "Airway", hint: "Head", color: "#b18cff" },
  ];
  const actions = [
    { id: "examine", label: "Examine", hint: "Body regions", color: "#7ee0c0" },
    { id: "records", label: "Records", hint: "Chart", color: "#ffb84a" },
  ];
  const markup = buildViewWheelMarkup(views, actions);
  // Views still steer the camera; destinations report themselves instead.
  assert.equal((markup.match(/data-camera=/g) ?? []).length, 3);
  assert.equal((markup.match(/data-nav=/g) ?? []).length, 2);
  assert.match(markup, /data-nav="examine"/);
  assert.match(markup, /view-wheel__wedge--action/);
  // The hub still steps only through views — a destination is chosen, not
  // cycled onto.
  assert.match(markup, /aria-label="Next camera view: Patient"/);
});

test("buildViewWheelMarkup keeps the wheel within eight wedges", () => {
  const views = Array.from({ length: 5 }, (_, index) => ({
    id: `v${index}`, label: `V${index}`, hint: "hint", color: "#5aa9ff",
  }));
  const actions = Array.from({ length: 4 }, (_, index) => ({
    id: `a${index}`, label: `A${index}`, hint: "hint", color: "#ffb84a",
  }));
  assert.throws(() => buildViewWheelMarkup(views, actions), /8 wedges or fewer/);
  assert.throws(() => buildViewWheelMarkup(views, [{ id: "x", label: "", hint: "h", color: "#fff" }]),
    /id, label, hint, and color/);
});
