// The 15 Oculus visemes, in the canonical order Rohy's avatar pipeline
// produces.
//
// VENDORED from Rohy: src/utils/visemes.js, byte-for-byte in content and
// order. Rohy's RocketBox conversion writes morph targets in exactly this
// order, its PatientAvatar morph driver reads the same list, and this room
// is driven by the same viseme stream from the same TTS service — so the
// order must not be re-derived here. If Rohy's list changes, copy it again
// rather than editing this file independently.
//
// Index 0 (`viseme_sil`) is silence; the remaining 14 cover the standard
// English phoneme set.
export const VISEME_KEYS = [
  "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD",
  "viseme_kk",  "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR",
  "viseme_aa",  "viseme_E",  "viseme_I",  "viseme_O",  "viseme_U",
];

// Everything that is not silence — the keys whose influence means "a mouth
// is currently forming a sound".
export const SPEAKING_VISEME_KEYS = VISEME_KEYS.filter((key) => key !== "viseme_sil");
