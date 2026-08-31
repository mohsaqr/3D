### 2026-08-31 — Establish the private 3D project repository
- `.git/`: Initialized a dedicated `main` repository in this directory so it no longer inherits the unrelated home-level Git repository.
- `HANDOFF.md`, `LEARNINGS.md`: Recorded the private remote, repository boundary, verification state, and continuation context.
- GitHub: Created the private `mohsaqr/3D` repository and configured it as `origin`.

### 2026-08-31 — Replace the procedural patient with a rigged full-body Rohy avatar
- `public/avatars/avatarsdk.glb`: Bundled the selected, realistically textured 1.815 m full-body patient already available to Rohy.
- `public/licenses/talkinghead.LICENSE.txt`, `THIRD_PARTY_NOTICES.md`: Retained the MIT license and documented the avatar's source.
- `src/scene.js`: Added GLB loading, skeleton-safe cloning, standard/RocketBox bone lookup, supine arm posing, facial morph animation, respiratory-rate-driven breathing, status-sensitive complexion, and a shaped bed blanket. The procedural patient remains only as a load fallback.
- `src/main.js`, `src/simulation.js`: Recast the example as Daniel Moreau, 54, and connected avatar readiness to accessible status messaging.
- `scripts/browser-smoke.mjs`: Added a hard assertion that the real avatar loaded plus a dedicated patient close-up screenshot and avatar resource diagnostics.
- `tests/avatar-asset.test.js`, `tests/scene.test.js`: Added GLB structure/licensing contracts and synthetic rig tests for loading, material isolation, posing, breathing, blink/viseme aliases, complexion, and fallback behavior.
- `README.md`: Documented the rigged patient architecture, evidence, fallback, and third-party attribution.
- Tests: 61/61 unit tests pass; browser smoke passes with no page errors; production build succeeds and contains the GLB and license.

### 2026-08-31 — Build the Rohy 3D patient-room simulation
- `src/scene.js`: Added a full procedural hospital room, full-body patient, equipment, camera presets, object selection, lighting, and physiological patient animation.
- `src/simulation.js`: Added deterministic vital-sign, intervention, scoring, objective, timeline, deterioration, and validation logic.
- `src/main.js`: Added the complete accessible simulation interface, clinical workflow, live monitor, outcome checkpoint, keyboard controls, and WebGL fallback.
- `src/styles.css`: Added the responsive Rohy visual system, glass clinical panels, monitor and waveform styling, modal states, high contrast, and reduced motion.
- `index.html`, `package.json`, `vite.config.js`: Added the Vite/Three.js application shell, dependency pinning, build scripts, and lazy scene bundling.
- `tests/simulation.test.js`, `tests/scene.test.js`: Added 42 unit tests for simulation and scene behavior; all pass.
- `scripts/browser-smoke.mjs`: Added a desktop/mobile Chrome interaction test; all checks pass with no page or console errors.
- `README.md`: Added setup, verification, feature, and architecture documentation.
- Tests: `npm test`, `npm run test:browser`, and `npm run build` pass.
