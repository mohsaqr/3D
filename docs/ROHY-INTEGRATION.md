# Plan: Embedding the 3D Patient Room in Rohy

Status: proposal (2026-08-31) · Target: `rohySimulator-2.9` (React 19 + Vite + Express/SQLite)
Owner repo of this prototype: `mohsaqr/3D` (standalone Vite + Three.js 0.185.1, vanilla JS)

## Where both sides stand today

**This prototype** is deliberately renderer-split: `src/simulation.js` is a pure
scenario engine, `src/scene.js` owns a Three.js renderer and a normalized avatar
rig (Standard + RocketBox bone naming), and `src/main.js` builds its own full-page
DOM and boots on import. It bundles one Rohy GLB (`avatarsdk.glb`) and verifies
itself with 74 unit tests plus a CDP browser smoke test.

**Rohy** already renders the same avatar catalogue (28 full-body GLBs under
`public/avatars/heads/` with `manifest.json`) through React Three Fiber
(`src/components/chat/PatientAvatar.jsx` — useGLTF, SkeletonUtils, eye-bone gaze,
viseme lip-sync), resolves avatars per case via `resolveAvatarId`, runs a room
navigator (Patient / Examination / Laboratory / Radiology / Consultant), stamps
every learner action with the active room in EventLogger, and pins
`three@^0.184.0`. Tests are Vitest + Playwright.

## Recommended shape: a mounted library room, not a rewrite

Port nothing to R3F initially. Wrap this prototype's imperative scene behind a
small mount API and give Rohy a new lazy room that hosts it, exactly the way the
lessons room is lazy-loaded today. The R3F `PatientAvatar` (head-and-shoulders,
conversational) and this full-room scene serve different moments of a case; they
can coexist and share only assets and data contracts.

Two renderers on one page is fine (each owns its own canvas), but two *copies of
three.js* in one bundle is not. Version alignment is Phase 1 work.

## Phase 0 — Mountable API in this repo — **IMPLEMENTED 2026-08-31**

`src/main.js` now exports `mountPatientRoom(container, options)`:

- `options.mode`: `"standalone"` (default; built-in engine, unchanged behavior)
  or `"bound"` — the host owns the case. Bound mode renders the room, patient
  panel, live monitor, timeline, cameras, and rig, but omits the built-in
  scenario chrome (brief, objectives, action dock, score, pause).
- `options.patient` — real patient record (name, initials, age, pronouns,
  speaker, presenting_concern, background, allergies, location, bed_label,
  case_title, arrival_note, opening_line), merged over the demo default.
- `options.avatar_url` — threaded to the GLB loader, so Rohy can point at its
  own `/avatars/heads/<id>.glb`.
- `options.on_event(event)` — emits `{type: "action"|"selection"|"status"|"avatar"}`
  payloads for the host's EventLogger.
- Returns `{ dispose, update(vitals, status, elapsed), addTimelineEvent(message,
  type, time), say(line), applyAction(id), focusPreset(name), getState }`.
  `update()`/`addTimelineEvent()`/`say()` are the bound-mode feed; trends in
  bound mode come from the recorded feed (`sampleTrendRows`), not the demo
  engine. `dispose()` clears every interval/timeout/listener and empties the
  container (React 19 StrictMode-safe: idempotent).
- CSS is scoped under `.rohy3d-root` (variables included); page-level rules
  apply only under `.rohy3d-page`, set by the standalone `index.html`. Modal
  overlays are `position: absolute` inside the root, not fixed.
- `package.json` exposes `exports` and moved `three` to a peer dependency
  (`^0.184.0 || ^0.185.0`) so Rohy's copy is the only one bundled.
- Verified: 75 unit tests plus a bound-mode browser smoke check that mounts a
  second room, feeds host vitals/events, asserts the DOM, and disposes cleanly.

## Phase 1 — Rohy hosts the room — **IMPLEMENTED 2026-08-31** (as an overlay)

What shipped in `rohySimulator-2.9` (all additive):

- `package.json`: `rohy-3d-patient-room: file:../3D`; `vite.config.js`:
  `resolve.dedupe: ['three']` — verified by the production build emitting a
  single shared `three.module` chunk used by both PatientAvatar and the room.
- `src/components/room3d/caseBinding.js` — pure mapping: active case →
  room patient record (name, demographics, allergies, chief complaint,
  greeting), `EventLogger.currentVitals` (snake_case, may hold "?" in arrest
  states) → engine vitals or `null`, and case `avatar_id` →
  `/avatars/heads/<id>.glb`.
- `src/components/room3d/Room3DScreen.jsx` — lazy full-screen **overlay**
  (not a RoomNavigator room): architecture mapping showed Rohy's physiology is
  100% client-side inside `PatientMonitor` with no server live-vitals feed, so
  the chat room must stay mounted underneath; the overlay polls
  `EventLogger.currentVitals` once per second into `controller.update()` and
  stamps `EventLogger.roomChanged('room3d')` / restores on close.
- `src/App.jsx` — four additive edits: lazy import, `show3DRoom` state, an
  `oyonRoom` branch, and a "3D Room" button (chat room only) + Suspense overlay.
- Tests: `caseBinding.test.js` + `Room3DScreen.test.jsx` (10 tests, passing).
  The null-coercion test caught a real bug (`Number(null) === 0` rendering
  absent vitals as zeros).

Still open from the original Phase 1 sketch: registering as a real
RoomNavigator room is intentionally NOT done (overlay is the correct shape
until vitals state is hoisted, see Phase 2); UI strings are literal English
pending i18n keys.

### Original Phase 1 sketch (superseded above)

1. In `rohySimulator-2.9`: `npm i file:../3D` (later a git/npm reference).
   Align three: either bump Rohy to 0.185.x or relax this repo to `^0.184.0` —
   pick one, verify with `npm ls three` that exactly one copy resolves, and add
   a CI assertion for it.
2. New component `src/components/room3d/AcuteRoom3D.jsx`:
   `useEffect(() => { const room = mountPatientRoom(ref.current, {...}); return room.dispose; }, [])`.
   Lazy-load it (`React.lazy`) so Three.js stays out of Rohy's initial bundle,
   mirroring the lessons-room pattern.
3. Register a room id (e.g. `sim3d`) in the RoomNavigator and feature-flag it
   per case (`case.rooms.includes('sim3d')`).
4. Assets: pass `avatar_url: baseUrl + '/avatars/heads/' + resolveAvatarId(case)`
   so the room shows *the same patient* as the chat avatar, from Rohy's existing
   files. Drop the bundled GLB from the production build at this point (keep it
   for standalone dev); keep the MIT attribution where the GLBs live.
5. Telemetry: forward `on_event` into EventLogger with `data.room = 'sim3d'` so
   the TNA analytics dashboard sees 3D-room actions like any other room's.

Definition of done: a case opens the 3D room inside Rohy, shows the
case-appropriate avatar, logs events, and `npm ls three` shows one copy.

## Phase 2 — One physiology, two views (bind the data)

The prototype currently runs its own deterministic engine. Rohy already has
treatments that produce time-decaying vital changes and a live monitor. Bind
them instead of running both:

1. Add a *bound mode* to the mount: the host drives
   `scene.update(status, vitals, elapsed)` from Rohy's vitals stream, and the
   built-in engine is bypassed (it stays for standalone mode).
2. Map 3D object selections to Rohy actions: clicking the monitor opens Rohy's
   monitor view, clicking the patient routes to examination, the oxygen station
   to the oxygen treatment dialog. The selection ids
   (`patient/bed/monitor/oxygen/iv/chart`) already exist in the mount's event
   payloads.
3. The breathing/complexion/status-light rig needs only
   `{respiratory_rate, oxygen_saturation, status}` — Rohy's vitals already
   carry these.
4. Numerical guard: one Vitest suite in Rohy replays a recorded vitals stream
   into the mount and snapshots the rig outputs, so an engine change on either
   side is caught.

## Phase 3 — Scenario manifest and authoring

1. Extract this repo's case (`BASELINE_VITALS`, `ACTION_DEFINITIONS`,
   objectives, patient identity, replies) into a JSON scenario document with a
   schema; `createSimulation(scenario)` loads it. This is the step that turns
   "one hard-coded respiratory case" into a library of cases.
2. Store scenarios in Rohy's case editor next to `avatar_id`/voice so one case
   record configures chat, monitor and the 3D room together.
3. Later (optional): port the room to R3F components inside Rohy for deeper
   composition (shared lighting/gaze with PatientAvatar). Do this only if
   Phase 1's iframe-like isolation becomes limiting — it is a rewrite of
   `scene.js`'s room, not of the engine.

## Phase EXAM — The 3D room becomes the Examination room (planned 2026-08-31)

Goal: retire the overlay. `RoomNavigator → examination` renders the 3D room
full-screen (PhysicalExamScreen pattern: screen owns the bottom nav, no Back
button), and physical examination happens by clicking the patient's 3D body.
The room id stays `examination` so EventLogger/TNA analytics are continuous.

### Constraint (user, 2026-08-31): ADDITIVE ONLY while testing
The user is actively testing Rohy. Until they lift this, every step must be
a pure addition: the existing Examination room (PhysicalExamScreen /
ManikinPanel / BodyMap), PatientMonitor, and all current room behavior stay
untouched and behave identically when the new surface is not visited.
"Replace the examination room" is the FINAL, separately-approved step.

### Phase A — An additional room — **IMPLEMENTED 2026-08-31** (Rohy working tree only, uncommitted by user rule)
1. Add a sixth RoomNavigator entry (key `exam3d`, its own label/icon) and an
   App ternary branch rendering a new `Exam3DScreen` — new rows and new
   files only; the existing `examination` room is not modified. Remove
   nothing yet: the overlay button/state may stay or be dropped in the same
   step (dropping it touches only code this integration added, which counts
   as additive-scope).
2. **Vitals bridge, scoped to the new room only**: while `exam3d` is
   active, keep the chat layout mounted but hidden so PatientMonitor keeps
   simulating and `EventLogger.currentVitals` stays live. Zero effect on any
   other room (elsewhere the tree renders exactly as today).
3. Slim room chrome for room-mode: `chrome: "room"` mount option (new,
   optional) hides the room package's own brand/topbar duplication.
4. EventLogger stamps `room: 'exam3d'` via the existing roomChanged effect —
   no analytics code changes; TNA simply gains a new room id.

### Phase B — Physical exam on the 3D body — **IMPLEMENTED 2026-08-31** (package committed; plugin worktree uncommitted)
1. Package: invisible **region colliders** attached to the normalized rig
   bones (head/neck, chest, abdomen quadrants, pelvis, each arm/forearm/hand,
   thigh/leg/foot…), ids matching Rohy's `BODY_REGIONS`; raycast → emit
   `{type: "selection", id: "region:<id>"}` + hover highlight. A
   `body_regions` option carries the mapping so the package stays
   Rohy-agnostic.
2. Rohy: extract ManikinPanel's exam logic (`handleExamTypeSelect`,
   findings from case config, `getExamTypesForRegion`/`getDefaultFinding`)
   into a shared `usePhysicalExam` hook. On a region selection the exam
   technique panel (existing ExamTypeSelector/FindingDisplay components)
   opens beside the 3D view; performing an exam logs exactly what the 2D
   flow logs (`EventLogger.physicalExamPerformed`, PatientRecord
   `examined`/`elicited`) — analytics parity by construction.
3. **Parity guarantee**: the full 67-region list + techniques panel remains
   available as a side list (also the keyboard/accessibility path), so
   regions not yet clickable in 3D (posterior while supine) are never lost.
   ExamNotesDrawer carries over unchanged.
4. Patient reactions: exam findings can drive `say()` and the rig (grimace
   on tender abdomen) — optional polish.

### Phase EXAM-WHEEL — Radial exam wheel + finding card — **IMPLEMENTED 2026-08-31** (package committed; plugin worktree uncommitted)
The text exam menu is gone from the primary flow. The examination interaction
is now fully diegetic and lives in the PACKAGE (host-agnostic):

1. Package: `body_regions` entries may carry `exams: [{id, label, hint,
   tests?}]`. Clicking such a region blooms a **radial exam wheel** at the
   click point (clamped to the stage): clip-path wedges in the view wheel's
   visual language, one per technique, fixed clinical order (inspect →
   palpate → percuss → auscultate → special), fixed per-technique color +
   glyph (never color alone), hub = "EXAMINE · <region>". A `special`
   technique with 2+ named tests morphs the wheel into a **sub-ring** (tests
   clockwise from 12, Back wedge pinned near 6 o'clock); exactly one test
   flattens onto the main ring. Wedge pick → `options.on_exam({region_id,
   exam_id, test, …})` (sync or Promise, single-flight with epoch discard) →
   glass **finding card** bottom-center (REGION · TECHNIQUE kicker, amber
   ABNORMAL chip + accent bar, audio chips with equalizer bars, one owned
   Audio element, auscultation auto-plays until the learner pauses one).
   The room itself emphasizes + glides to the region, marks it
   examined/abnormal, and winces on a first abnormal. Done-ticks (teal /
   amber) appear on reopened wheels. Esc unwinds one level per press
   (sub-ring → wheel → card); a transparent scrim keeps dismiss-clicks off
   OrbitControls. Controller: `openExamWheel(region_id, point?)`,
   `closeExamWheel()`, `getExamLog()`. Events: `exam_open`, `exam`,
   `exam_close` through `on_event`.
2. Plugin worktree: `examWheelData.js` feeds the wheel Rohy's REAL model
   (`BODY_REGIONS.examTypes` + `specialTests` relabeled as verbs — nothing
   invented); `useExamPerformer` is the single ManikinPanel-parity perform
   path (EventLogger + PatientRecord verbs) now shared by the wheel's
   `on_exam` AND the ExamPanel fallback; auscultation audio resolves with
   AuscultationPanel's exact precedence (per-point → heart/lung custom →
   region audioUrl → canned normals, never for abdomen/abnormal).
   ExamPanel (full anterior/posterior BodyMap) stays reachable behind a
   "Body map" pill — the parity guarantee for regions a supine view hides.
3. Verification: package 102 unit tests + CDP smoke journey (wheel blooms on
   chest click, auscultation → abnormal card with audio chips, done-tick on
   reopen, abdomen sub-ring + badge + Back + Esc layering, named-test card,
   Esc closes card) with screenshots `tmp/rohy-browser-smoke-exam-wheel.png`
   and `tmp/rohy-browser-smoke-finding.png`; worktree 2 888 Vitest tests
   green (plugin 38 incl. wheel-data + audio-precedence suites), eslint
   clean.

### Phase C — Hoist physiology to session scope (1 session; NOT additive — deferred until the user lifts the testing constraint)
Extract PatientMonitor's simulation state + loops (params, rhythm, scenario
keyframes, treatment-effects application, jitter, deadband persistence) into
a `PhysiologyProvider` mounted at App session scope; PatientMonitor becomes a
view of it; the Phase A hidden-mount bridge is deleted; every room gets live
vitals. Highest-risk refactor (PatientMonitor is ~1800 lines with admin
editing intertwined) — its 17 tests must stay green; provider gets its own.

### Decision (user, 2026-09-01): the 2D examination room is demoted, not deleted
"The examination room can be introductory screen or an extra one. I don't want
any re-invention of the wheel."

Two things follow:

1. **End state**: the 3D room is the examination experience; the existing 2D
   examination room stays as an introduction (first-visit orientation) or
   simply as an extra room. Nothing about it gets rebuilt or removed — Phase D
   is a navigator ordering/label change, not a rewrite. It stays one line in
   `PLUGIN_ROOMS` / `RoomNavigator` whenever the testing constraint lifts.
2. **Standing rule — no duplicated implementations.** Acted on 2026-09-01 by
   collapsing the two the plugin still carried:
   - `useExamPerformer.js` (plugin) was a parallel copy of
     ManikinPanel.handleExamTypeSelect — and had already drifted: it wrote the
     `"<test>: <finding>"` string into the patient record where ManikinPanel
     writes the raw finding. Now one hook, `src/hooks/usePhysicalExam.js`,
     extracted out of ManikinPanel and used by both rooms; the plugin copy is
     deleted. EventLogger stays with the screen in both cases, so the `room3d`
     marker still tells the rooms apart.
   - `plugins/room3d/ecgWaveform.js` held a verbatim copy of PatientMonitor's
     `gaussMs`/`cardiacIntervals`/`GenerateECGRaw`. The generator now lives in
     `src/services/ecgWaveform.js`; PatientMonitor imports it (its 17 tests
     pass unchanged) and the plugin keeps only the sampler.

### Phase VOICE-V2 — The learner talks to the patient — **IMPLEMENTED 2026-09-01** (plugin worktree only, uncommitted by user rule)
"I need microphone controls on the 3D room and talks." This is V2 of the
voice plan (`rohy-3d-plugin/tmp/voice-plan.html`), built as connection rather
than construction — every piece of the turn already existed in Rohy:

| Need | Reused, not written |
|---|---|
| Microphone + recogniser lifecycle | `components/discussion/VoiceControl.jsx` (three additive props; six characterization tests pin the debrief behaviour first) |
| Who the patient is | `utils/lastPatientPrompt` — the exact prompt ChatInterface assembles, which it pre-warms on every case change and which stays warm because ChatInterface is still mounted (hidden + inert) under the room |
| The conversation so far | `GET /interactions/:sessionId` — the session's real patient thread; `LLMService.streamMessage` persists both sides, so a room question lands in the educator's transcript |
| Sentence-at-a-time speech | `VoiceService.beginSpeechSession` + `utils/sentenceSplit` — the chat's own low-latency path |
| Captions | `components/voice/SubtitleBand` + `useSubtitleReveal` |
| Language | `sttLocaleFor(case language)` — an Italian session is spoken and heard in Italian |

New plugin code is only the two joins: `useRoomConversation.js` (the turn)
and a `beginSession()` on `usePatientVoice.js` so scripted lines and streamed
replies share one resolver and one audio path.

Three decisions worth keeping:

1. **The room refuses to invent a persona.** The cached prompt is checked
   against the case in focus; a mismatch (or an empty cache) means the room
   says it is not ready, rather than asking the model to improvise a patient.
   Same stance the voice resolver takes about substituting voices.
2. **The space bar is shielded, not merely used.** ChatInterface's own
   window-level space-bar voice turn is still live underneath. The room's
   listener is on the **capture** phase and stops propagation, so one press
   opens one microphone. Pinned by a test with a stand-in chat listener that
   fails if the listener is moved to the bubble phase.
3. **Barge-in is a prop, not a fork.** `onInterrupt` makes the mic outrank
   the patient's sentence in the room; the debrief passes nothing and keeps
   letting the discussant finish.

Verified: 1614 client tests pass (150 files), production build clean, both
sabotage checks (persona guard, capture-phase shield) fail the right tests.
Not verified: a live microphone — that needs a real browser with a granted
permission and a logged-in session.

Still open — V3: audio arbitration between speech, stethoscope clips and
alarms. A clip started by hand can still overlap a spoken line.

### Phase VOICE-LIPS — The patient's mouth moves — **IMPLEMENTED 2026-09-01** (package committed)
"and lips dont move" — and they could not have: the room's avatar drove
`jawOpen` / `mouthOpen` / `viseme_O` from the **breathing envelope alone**.
There was no viseme input in the package at all.

Per the standing rule ("no re-invention of the wheel"), the driver is PORTED
from Rohy's `PatientAvatar` rather than invented:

- `src/visemes.js` — `VISEME_KEYS` vendored from Rohy's `utils/visemes.js`,
  byte-for-byte and with provenance, because the same TTS stream drives both
  faces and the order must not be re-derived.
- `updateRiggedPatient` eases each viseme morph in place with Rohy's own
  asymmetric rates (rise `12·delta`, decay `8·delta` — a mouth opens faster
  than it closes). Rohy gets its delta from `useFrame`; this room's avatar
  update takes scenario time only, so the frame delta is measured on the rig
  and clamped so a backgrounded tab cannot jump the mouth.
- `controller.setVisemes(map)` is the new public API; `usePatientVoice` emits
  every map to BOTH VoiceContext (Rohy's avatar) and the room, through a ref
  rather than React state — visemes arrive at frame rate and a render each
  would re-render the whole room while the patient talks.

Two necessary modifications, both deliberate:

1. **`viseme_O` left the breathing drive.** It is a speech morph; letting the
   breath hold it at 0.0098 would fight the lipsync for the same influence
   every frame. Two existing package tests asserted the old behaviour and
   were updated with the reasoning inline.
2. **Rigs without viseme morphs still move.** Not every avatar ships the 15
   Oculus visemes; on those, the eased speech envelope opens `jawOpen`, so
   the patient is visibly talking rather than staring through a reply.

A test caught a real bug during the port: guarding the easing loop on "there
are visemes" left the last mouth shape frozen on the face when the voice
stopped. Rohy runs the loop every frame, silence included — so does this now.

Verified: 109 package tests, browser smoke passes, 1621 client tests.
Package `0.3.0` → `0.4.0`.

### Phase VOICE-PERSONA — The room resolves the patient's own voice — **IMPLEMENTED 2026-09-01** (plugin worktree only)
"It is just using the woman voice..." The room called Rohy's `resolveVoice`
but passed only 2 of its 3 tiers. The persona tier — the Patient template's
configured voice — was applied by a `resolveSpeakerVoice` wrapper *inside
ChatInterface*, so the room fell straight through to the platform's
per-language default, `af_bella`, for every case with no explicit voice.
That default is female, so male patients spoke in a woman's voice while the
chat room, using the wrapper, was correct.

Reuse per the standing rule: the template resolution (per-case attached
agent → platform default matched on the case's gender) was extracted
VERBATIM out of ChatInterface's agents loader into
`src/utils/patientTemplate.js`, with 9 characterization tests written first.
ChatInterface now calls the extraction, so the rooms cannot drift. The
room's new `usePatientTemplate` resolves the same persona from the same
session agents, and `usePatientVoice` passes `templateVoice` through.

The extracted resolver's deliberate asymmetry is now pinned rather than
looking like an oversight: a female-coded case with only male templates
seeded resolves to **null** — a visible misconfig — instead of silently
speaking as a man.

Verified against the seeded database: "Default Patient" (male, `am_michael`)
and "Default Female Patient" (female, `af_bella`). 1631 client tests pass.

### Phase D — Replacement and polish (only after the user lifts the additive constraint)
With the user's explicit go-ahead after their testing: point the
`examination` key at `Exam3DScreen` (or merge the rooms), retire the 2D
BodyMap *route* while keeping the region list panel forever, i18n keys,
posterior access (log-roll), exam-driven patient reactions, Playwright e2e
(navigate → examine region → finding logged).

### Decisions recorded (user, 2026-08-31)
- 2D body map: KEEP as fallback inside the 3D exam experience until parity is proven.
- Scope: additive only while the user is testing — zero changes to existing behavior; replacement deferred to Phase D with explicit approval.
- Implementation: not started — plan only for now.

## Testing and verification (carried through every phase)

- This repo's 74 unit tests and the CDP smoke test keep running unchanged; they
  are the library's contract tests.
- Rohy gains: a mount/dispose Vitest, a Playwright e2e that opens the 3D room,
  waits for `data-avatar-ready="true"` (the smoke test's fallback-rejection
  assertion, ported), performs one action, and checks the EventLogger row.
- Version/duplication guards: `npm ls three` single-copy check in Rohy CI.
- Keep the avatar retry (3 attempts) and the visible "reduced visuals" notice —
  in Rohy the notice should also emit an EventLogger warning so degraded
  sessions are measurable.

## Risks and decisions to make early

| Risk | Mitigation |
|---|---|
| Two three.js copies bloat/misbehave | Align versions in Phase 1; CI guard |
| CSS bleed into Rohy | Scope styles under `.rohy3d` in Phase 0 |
| Double physiology drift | Phase 2 bound mode; single source of truth per session |
| GLB duplication (12 MB) | Serve from Rohy's existing `/avatars/heads/`; drop the bundled copy in embedded builds |
| React 19 StrictMode double-mount | `dispose()` must be idempotent; test it |
| Mobile: Rohy layout + full 3D room | The prototype's simplified-dashboard mode is the small-screen fallback |

## Suggested order of work

Phase 0 is one focused session in this repo. Phase 1 is one session in Rohy
(wrapper, room registration, asset URL, telemetry). Phase 2 and 3 are each
independent follow-ups. Nothing in Phase 0–1 blocks continued standalone
development of this prototype.
