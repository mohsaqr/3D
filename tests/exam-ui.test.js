import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildExamWheelMarkup,
  buildFindingCardMarkup,
  clampWheelCenter,
  escapeHtml,
  examSubRingItems,
  examWheelItems,
  orderExamItems,
  radialWedgeGeometry,
} from "../src/ui-helpers.js";

const CHEST_EXAMS = [
  { id: "auscultation", label: "Auscultate", hint: "Listen" },
  { id: "inspection", label: "Inspect", hint: "Look" },
  { id: "percussion", label: "Percuss", hint: "Tap" },
  { id: "palpation", label: "Palpate", hint: "Feel" },
];

test("escapeHtml neutralizes markup-significant characters", () => {
  assert.equal(escapeHtml('S1 & S2 <b>"loud"</b>'), "S1 &amp; S2 &lt;b&gt;&quot;loud&quot;&lt;/b&gt;");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml("O'Neill"), "O&#39;Neill");
});

test("radialWedgeGeometry rejects counts outside 2 to 8", () => {
  [1, 9, 2.5, "4"].forEach((count) => {
    assert.throws(() => radialWedgeGeometry(count), /2 to 8/);
  });
});

test("radialWedgeGeometry keeps every polygon vertex inside the wheel", () => {
  [2, 5, 8].forEach((count) => {
    const geometry = radialWedgeGeometry(count);
    assert.equal(geometry.length, count);
    geometry.forEach((wedge) => {
      const coordinates = wedge.polygon.match(/-?\d+\.?\d*%/g).map(parseFloat);
      assert.ok(coordinates.length >= 36, "each wedge samples both arcs");
      coordinates.forEach((value) => {
        assert.ok(value >= 0 && value <= 100, `vertex ${value}% escapes the wheel`);
      });
    });
  });
});

test("radialWedgeGeometry centers the first wedge at 12 o'clock", () => {
  const [first] = radialWedgeGeometry(4);
  assert.ok(Math.abs(parseFloat(first.label_left) - 50) < 1, "first label is horizontally centered");
  assert.ok(parseFloat(first.label_top) < 40, "first label sits in the top half");
});

test("orderExamItems applies the canonical clinical order", () => {
  const ordered = orderExamItems([
    { id: "special" },
    { id: "auscultation" },
    { id: "mentalStatus" },
    { id: "inspection" },
    { id: "palpation" },
  ]);
  assert.deepEqual(
    ordered.map((exam) => exam.id),
    ["inspection", "palpation", "auscultation", "special", "mentalStatus"],
  );
});

test("examWheelItems flattens a single special test onto the main ring", () => {
  const items = examWheelItems([
    { id: "inspection", label: "Inspect" },
    { id: "special", label: "Special", tests: ["Pupil reflex"] },
  ]);
  const special = items.find((item) => item.id === "special");
  assert.equal(special.label, "Pupil reflex");
  assert.equal(special.test, "Pupil reflex");
  assert.equal(special.badge, null);
});

test("examWheelItems badges multi-test special and carries done-state", () => {
  const items = examWheelItems(
    [
      { id: "palpation", label: "Palpate" },
      { id: "special", label: "Special", tests: ["JVP assessment", "Thyroid exam", "Lymph node exam"] },
    ],
    { palpation: "abnormal" },
  );
  const special = items.find((item) => item.id === "special");
  assert.equal(special.badge, 3);
  assert.equal(special.test, null);
  assert.equal(items.find((item) => item.id === "palpation").done, "abnormal");
  assert.equal(special.done, null);
});

test("examWheelItems rejects an empty region", () => {
  assert.throws(() => examWheelItems([]), /non-empty/);
});

test("examSubRingItems pins the back wedge nearest 6 o'clock", () => {
  const three = examSubRingItems(["A", "B", "C"]);
  assert.equal(three.length, 4);
  assert.ok(three[2].back, "with 4 wedges, index 2 is exactly 6 o'clock");
  const five = examSubRingItems(["A", "B", "C", "D", "E"], { C: "examined" });
  assert.equal(five.length, 6);
  assert.ok(five[3].back, "with 6 wedges, index 3 is exactly 6 o'clock");
  assert.equal(five.find((item) => item.test === "C").done, "examined");
});

test("examSubRingItems validates the test list", () => {
  assert.throws(() => examSubRingItems(["only one"]), /2 to 7/);
  assert.throws(() => examSubRingItems(["a", "b", "c", "d", "e", "f", "g", "h"]), /2 to 7/);
  assert.throws(() => examSubRingItems(["ok", ""]), /2 to 7/);
});

test("clampWheelCenter keeps the wheel inside the stage", () => {
  assert.deepEqual(clampWheelCenter(10, 10, 1280, 720), { x: 166, y: 166 });
  assert.deepEqual(clampWheelCenter(1270, 710, 1280, 720), { x: 1114, y: 554 });
  assert.deepEqual(clampWheelCenter(400, 300, 1280, 720), { x: 400, y: 300 });
  // A stage narrower than the wheel centers on that axis instead.
  assert.deepEqual(clampWheelCenter(5, 300, 300, 720), { x: 150, y: 300 });
  assert.throws(() => clampWheelCenter(Number.NaN, 0, 100, 100), /finite/);
});

test("buildExamWheelMarkup renders wedges, badge, done ticks, and the hub", () => {
  const items = examWheelItems(
    [
      ...CHEST_EXAMS,
      { id: "special", label: "Special", tests: ["JVP assessment", "Thyroid exam"] },
    ],
    { auscultation: "examined" },
  ).map((item) => ({ ...item, color: "#2ae0bd", icon: "<svg></svg>" }));
  const markup = buildExamWheelMarkup("Anterior chest", items);
  assert.match(markup, /data-exam="inspection"/);
  assert.match(markup, /class="exam-wheel__badge">2</);
  assert.match(markup, /exam-wheel__done--examined/);
  assert.match(markup, /<small>EXAMINE<\/small>/);
  assert.match(markup, /<strong>Anterior chest<\/strong>/);
  // With no next region given, the hub still just closes.
  assert.match(markup, /aria-label="Close examination of Anterior chest"/);
  assert.doesNotMatch(markup, /exam-wheel__hub-next/);
  assert.equal((markup.match(/data-exam=/g) ?? []).length, 5);
  // 5 wedges keep their hints; the sub-ring test below drops them at 6+.
  assert.match(markup, /<small>Listen<\/small>/);
});

test("buildExamWheelMarkup renders the special sub-ring with back and test wedges", () => {
  const items = examSubRingItems(["JVP assessment", "Thyroid exam", "Lymph node exam", "Carotid bruit", "Tracheal position", "Pemberton's sign"])
    .map((item) => ({ ...item, color: item.back ? "#93a7ad" : "#4ecbe0" }));
  const markup = buildExamWheelMarkup("Neck", items, { ring: "special" });
  assert.match(markup, /data-back="true"/);
  assert.match(markup, /data-test="JVP assessment"/);
  assert.match(markup, /<small>SPECIAL TESTS<\/small>/);
  assert.match(markup, /aria-label="Back to examination techniques for Neck"/);
  // At 7 wedges the per-wedge hints are dropped for legibility.
  assert.doesNotMatch(markup, /<small>Special test<\/small>/);
});

test("buildExamWheelMarkup escapes host-supplied strings", () => {
  const markup = buildExamWheelMarkup("Chest <script>", [
    { id: "special", label: "Rinne & Weber's", hint: "", test: 'Rinne & "Weber"', color: "#4ecbe0" },
  ]);
  assert.match(markup, /Chest &lt;script&gt;/);
  assert.match(markup, /Rinne &amp; Weber&#39;s/);
  assert.match(markup, /data-test="Rinne &amp; &quot;Weber&quot;"/);
  assert.doesNotMatch(markup, /<script>/);
});

test("buildExamWheelMarkup validates its inputs", () => {
  assert.throws(() => buildExamWheelMarkup("", []), /region_label/);
  assert.throws(() => buildExamWheelMarkup("Chest", []), /1 to 8/);
  assert.throws(() => buildExamWheelMarkup("Chest", [{ id: "a", label: "" }]), /id, label, and color/);
  assert.throws(() => buildExamWheelMarkup("Chest", [{ id: "a", label: "A", color: "#fff" }], { ring: "nope" }), /ring/);
});

test("buildFindingCardMarkup presents a normal finding without the abnormal flag", () => {
  const markup = buildFindingCardMarkup({
    region_label: "Anterior chest",
    exam_label: "Auscultation",
    finding: "Vesicular breath sounds throughout.",
    abnormal: false,
  });
  assert.match(markup, /Anterior chest · Auscultation/);
  assert.match(markup, /Vesicular breath sounds/);
  assert.doesNotMatch(markup, /Abnormal/);
  assert.match(markup, /aria-live="polite"/);
});

test("buildFindingCardMarkup flags abnormal findings and lists audio chips", () => {
  const markup = buildFindingCardMarkup({
    region_label: "Precordium",
    exam_label: "Auscultation",
    finding: "Pansystolic murmur at the apex.",
    abnormal: true,
    audio: [
      { label: "Heart sounds", url: "/sounds/murmur.mp3" },
      { label: "Breath sounds", url: "/sounds/normal-lung.mp3" },
    ],
  });
  assert.match(markup, /finding-card__flag/);
  assert.equal((markup.match(/audio-chip"/g) ?? []).length, 2);
  assert.match(markup, /data-audio-url="\/sounds\/murmur.mp3"/);
  assert.match(markup, /Heart sounds/);
});

test("buildFindingCardMarkup renders an error card and escapes the finding", () => {
  const error_markup = buildFindingCardMarkup({
    region_label: "Chest",
    exam_label: "Palpation",
    error: "The examination could not be completed.",
  });
  assert.match(error_markup, /finding-card__error/);
  const escaped = buildFindingCardMarkup({
    region_label: "Chest",
    exam_label: "Palpation",
    finding: 'Tender <mass> & "guarding"',
    abnormal: true,
  });
  assert.match(escaped, /Tender &lt;mass&gt; &amp; &quot;guarding&quot;/);
});

test("buildFindingCardMarkup validates its inputs", () => {
  assert.throws(() => buildFindingCardMarkup({ region_label: "Chest", exam_label: "Palpation" }), /finding/);
  assert.throws(() => buildFindingCardMarkup({ region_label: "", exam_label: "x", finding: "y" }), /region_label/);
  assert.throws(() => buildFindingCardMarkup({
    region_label: "Chest",
    exam_label: "Auscultation",
    finding: "ok",
    audio: [{ label: "Heart" }],
  }), /audio/);
});

test("buildExamWheelMarkup turns the hub into a region stepper when given a next region", () => {
  const items = examWheelItems([{ id: "palpation", label: "Palpate", hint: "Feel" }])
    .map((item) => ({ ...item, color: "#2ae0bd" }));
  const markup = buildExamWheelMarkup("Anterior chest", items, { next_label: "Abdomen" });
  assert.match(markup, /aria-label="Examine the next region: Abdomen"/);
  assert.match(markup, /class="exam-wheel__hub-next">Abdomen/);
  // The sub-ring's hub still means "back", never "next".
  const sub = buildExamWheelMarkup("Neck", examSubRingItems(["A", "B"])
    .map((item) => ({ ...item, color: "#4ecbe0" })), { ring: "special", next_label: "Abdomen" });
  assert.match(sub, /aria-label="Back to examination techniques for Neck"/);
  assert.doesNotMatch(sub, /exam-wheel__hub-next/);
});

test("buildExamWheelMarkup escapes a next-region label", () => {
  const items = examWheelItems([{ id: "palpation", label: "Palpate" }])
    .map((item) => ({ ...item, color: "#2ae0bd" }));
  const markup = buildExamWheelMarkup("Chest", items, { next_label: 'Left "arm" & hand' });
  assert.match(markup, /Left &quot;arm&quot; &amp; hand/);
  assert.doesNotMatch(markup, /"arm"/);
});
