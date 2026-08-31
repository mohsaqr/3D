# Project Learnings

### 2026-08-31
- [project structure]: The workspace began empty, so the patient-room experience was built as a standalone Vite prototype with a renderer-independent scenario engine for easier future Rohy integration.
- [3D assets]: The room and equipment work well as Three.js primitives, but a textured rigged GLB is materially better than procedural geometry for a believable patient.
- [avatar audit]: Rohy's files under `avatars/heads/` are not head-only assets; all 28 inspected GLBs contain complete skinned bodies. The existing camera crop was hiding that capability.
- [avatar selection]: `avatarsdk.glb` is the strongest bundled contemporary example: a 1.815 m full body with 73 joints, separate body/clothing/shoes meshes, bilateral blink shapes, and at least 15 visemes.
- [patient posing]: A standing humanoid can be placed convincingly in bed by rotating the model supine and aiming upper-arm and forearm bone segments in world space; normalizing Standard and RocketBox bone names keeps the pipeline reusable.
- [asset delivery]: Copying the chosen GLB into this app's `public/avatars/` directory makes the production build self-contained; keeping the MIT license and a third-party notice preserves attribution.
- [loading]: Dynamically importing the 3D scene keeps the initial UI bundle near 31 kB minified while the Three.js scene loads as a separate chunk.
- [simulation]: Separating action history from derived physiology makes deterioration, treatment effects, scoring, objectives, and regression tests deterministic.
- [browser verification]: The Chrome DevTools Protocol is available through Node's built-in WebSocket support and can verify WebGL startup, interactions, camera controls, responsive overflow, and that the rigged patient loaded instead of the procedural fallback without adding a browser-testing package.
- [responsive layout]: The 1440×1000 and 390×844 browser checks both fit without page-level horizontal or vertical overflow.
- [repository boundary]: Before initialization, this directory inherited `/Users/mohammedsaqr/.git` and the unrelated `cris_stats` remote. Initializing a dedicated nested repository in `3D/` was required before staging to prevent unrelated home-directory work from entering the commit.
- [repository hosting]: The project is hosted in the private GitHub repository `mohsaqr/3D`; its 12.3 MB avatar is below GitHub's per-file size limit and can remain in normal Git without LFS.
