// Host-supplied text is data, never markup.
//
// Regression lock: buildAppMarkup wrote patient.* (case title, speaker,
// opening line, name, …), objective labels and timeline messages into
// innerHTML unescaped, so a case whose chief complaint carried
// `<img src=x onerror=…>` injected markup into every learner's Bedside room
// (rohy security audit 2026-10-26, F-26 / L5-01).
import { strict as assert } from "node:assert";
import { register } from "node:module";
import { test } from "node:test";

// main.js imports its stylesheet; node cannot load CSS, so it loads as nothing.
register(
  "data:text/javascript," + encodeURIComponent(
    "export async function load(url, context, next) {"
    + " if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };"
    + " return next(url, context); }",
  ),
  import.meta.url,
);

const { buildAppMarkup } = await import("../src/main.js");
const { buildRecordsMarkup, buildTreatmentsMarkup } = await import("../src/ui-helpers.js");

const PAYLOAD = '<img src=x onerror=alert(1)><meta http-equiv="refresh" content="0;url=https://evil.example/">';

const HOSTILE_PATIENT = {
  name: `Ann${PAYLOAD}`,
  initials: `A${PAYLOAD}`,
  age: `58${PAYLOAD}`,
  pronouns: `she/her${PAYLOAD}`,
  speaker: `ANN${PAYLOAD}`,
  presenting_concern: `Chest pain${PAYLOAD}`,
  background: `Diabetes${PAYLOAD}`,
  allergies: `None${PAYLOAD}`,
  location: `ED${PAYLOAD}`,
  bed_label: `BED 4${PAYLOAD}`,
  case_title: `Chest pain${PAYLOAD}`,
  arrival_note: `Ann presents${PAYLOAD}`,
  opening_line: `Hi${PAYLOAD}`,
};

for (const [mode, features] of [
  ["standalone", {}],
  ["bound", { slim_chrome: true, exam: true, finding_card: false, records: true, treatments: true }],
]) {
  test(`buildAppMarkup (${mode}) escapes every patient field`, () => {
    const html = buildAppMarkup({}, HOSTILE_PATIENT, mode, mode === "bound" ? "host" : "internal", features);
    assert.equal(html.includes("<img src=x"), false, "a raw <img> from patient text reached the markup");
    assert.equal(html.includes("<meta http-equiv"), false, "a raw <meta> from patient text reached the markup");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the text is still shown, escaped");
  });
}

test("records and treatments escape host-supplied text", () => {
  const records = buildRecordsMarkup([{ title: `History${PAYLOAD}`, entries: [{ label: `PMH${PAYLOAD}`, value: `Asthma${PAYLOAD}` }] }]);
  const treatments = buildTreatmentsMarkup(
    [{ name: `Aspirin${PAYLOAD}`, detail: `300 mg${PAYLOAD}`, status: `ordered${PAYLOAD}` }],
    [{ name: `Heparin${PAYLOAD}`, detail: `IV${PAYLOAD}` }],
  );
  for (const html of [records, treatments]) {
    assert.equal(html.includes("<img src=x"), false);
    assert.equal(html.includes("<meta http-equiv"), false);
  }
});
