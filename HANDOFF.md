# Session Handoff — 2026-08-31

## Completed
- Established this directory as its own Git repository on branch `main`; it no longer inherits the unrelated home-level `cris_stats` repository.
- Created the private GitHub repository `mohsaqr/3D`, configured it as `origin`, and pushed the complete project history.
- Replaced the toy-like default patient with the selected textured AvatarSDK full-body male already available to Rohy.
- Bundled the example as `public/avatars/avatarsdk.glb` and retained its TalkingHead MIT license and attribution.
- Added skeleton-safe GLB cloning, reusable standard/RocketBox bone lookup, neutral supine arm posing, and material isolation in `src/scene.js`.
- Connected respiratory rate and patient status to chest expansion, shoulder effort, subtle head movement, blinking, mouth movement, and complexion.
- Added a shaped blanket and patient close-up camera while retaining the procedural avatar only as an automatic load fallback.
- Recast the example patient as Daniel Moreau, 54, across the interface and scenario feedback.
- Added structural GLB/license tests, extensive synthetic rig tests, and a browser assertion that rejects fallback rendering.
- Generated current visual evidence in `tmp/rohy-browser-smoke-desktop.png` and `tmp/rohy-browser-smoke-patient.png`.

## Current State
- The private source repository is `https://github.com/mohsaqr/3D`; local `main` tracks `origin/main`.
- The development server is available at `http://127.0.0.1:5173/`.
- `npm test` passes all 61 tests with no failures.
- `npm run test:browser` passes the desktop/mobile interaction suite, confirms `avatarReady === "true"`, and reports no uncaught or console errors.
- `npm run build` succeeds; `dist/avatars/avatarsdk.glb` and the embedded license are present.
- The initial UI and Three.js scene remain separate build chunks, so clinical controls render before the 3D dependency finishes loading.
- The production experience is self-contained and does not depend on sibling-repository paths at runtime.

## Key Decisions
- Initialized a dedicated nested repository before staging because the directory initially resolved to `/Users/mohammedsaqr/.git`; this prevented unrelated user files and projects from entering the commit.
- Chose `avatarsdk.glb` because it is the most convincing contemporary bundled example and includes a 73-joint full-body rig plus useful facial morph targets.
- Kept the room procedural and isolated avatar behavior behind a normalized rig object so other compatible Rohy patients can replace the example without rewriting physiology.
- Used world-space bone aiming instead of hard-coded Euler rotations so both standard humanoid and RocketBox arm naming conventions can be posed in bed.
- Copied the selected asset into this app's public directory to keep builds deterministic and retained the upstream MIT notice.
- Kept the prior procedural patient strictly as a resilience fallback; the browser regression fails if production silently uses it.

## Open Issues
- The selected avatar wears a turquoise casual top rather than a purpose-built hospital gown; a gown mesh or material variant would improve clinical authenticity.
- The current physiology uses controlled procedural bone/morph motion rather than authored breathing, distress, coughing, or examination animation clips.
- The scenario is currently a single deterministic respiratory-distress case. A scenario manifest/schema and authoring UI would be the next step for multiple cases.
- Audio controls are represented in the interface, but no alarm, ambient, or patient voice assets are bundled.
- The prototype is standalone and has not been copied into the adjacent Rohy application or registered as a Rohy plugin.

## Next Steps
1. Integrate the standalone experience as a lazy Rohy plugin room, preserving the independent scenario engine.
2. Turn the normalized avatar loader into a patient manifest with per-model scale, bed offset, bone aliases, outfit, and demographic metadata.
3. Add selectable full-body demographic variants from Rohy's existing GLBs and a hospital-gown presentation layer.
4. Add authored breathing, coughing, distress, and examination clips, plus patient speech and viseme-driven lip sync.
5. Define a JSON scenario schema and expand the result checkpoint into a full debrief with decision rationale.

## Context
- GitHub remote: `origin` → `https://github.com/mohsaqr/3D.git` (private), default branch `main`.
- Requires Node.js and npm; this session used Node v25.5.0 and npm 11.8.0.
- Dependencies are pinned to Three.js 0.185.1 and Vite 8.2.2.
- The browser smoke test searches for Chrome automatically and used `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on this machine.
- `tmp/` browser evidence is intentionally retained for review but ignored by `.gitignore`.
- `public/avatars/avatarsdk.glb` is 12,284,040 bytes and is covered by `public/licenses/talkinghead.LICENSE.txt` and `THIRD_PARTY_NOTICES.md`.
