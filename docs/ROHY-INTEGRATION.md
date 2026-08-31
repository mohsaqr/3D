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

### Phase A — An additional room (1 session, additive)
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

### Phase B — Physical exam on the 3D body (1–2 sessions)
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

### Phase C — Hoist physiology to session scope (1 session; NOT additive — deferred until the user lifts the testing constraint)
Extract PatientMonitor's simulation state + loops (params, rhythm, scenario
keyframes, treatment-effects application, jitter, deadband persistence) into
a `PhysiologyProvider` mounted at App session scope; PatientMonitor becomes a
view of it; the Phase A hidden-mount bridge is deleted; every room gets live
vitals. Highest-risk refactor (PatientMonitor is ~1800 lines with admin
editing intertwined) — its 17 tests must stay green; provider gets its own.

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
