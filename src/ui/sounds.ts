/**
 * UI sounds, synthesized with @web-kits/audio: no audio files, nothing loud.
 * Everything routes through play(), which respects the user's setting.
 */
import { defineSound, ensureReady, setMasterVolume, type SoundDefinition } from "@web-kits/audio"

const chime = (notes: number[], gap: number, gain: number): SoundDefinition => ({
  layers: notes.map((f, i) => ({
    source: { type: "sine", frequency: f },
    envelope: { attack: 0.004, decay: 0.45, sustain: 0, release: 0.1 },
    gain: gain * (1 - i * 0.12),
    delay: i * gap,
  })),
})

const SOUNDS = {
  /** Nav items, chips, segmented controls. */
  tick: defineSound({ source: { type: "sine", frequency: { start: 1900, end: 1300 } }, envelope: { attack: 0.001, decay: 0.022 }, gain: 0.1 }),
  toggleOn: defineSound({ source: { type: "triangle", frequency: { start: 620, end: 940 } }, envelope: { attack: 0.002, decay: 0.07 }, gain: 0.16 }),
  toggleOff: defineSound({ source: { type: "triangle", frequency: { start: 940, end: 620 } }, envelope: { attack: 0.002, decay: 0.07 }, gain: 0.14 }),
  /** Palette and lightbox. */
  open: defineSound({
    layers: [
      { source: { type: "sine", frequency: { start: 380, end: 720 } }, envelope: { attack: 0.006, decay: 0.12 }, gain: 0.13 },
      { source: { type: "noise", color: "pink" }, filter: { type: "bandpass", frequency: 3200 }, envelope: { decay: 0.05 }, gain: 0.04 },
    ],
  }),
  close: defineSound({ source: { type: "sine", frequency: { start: 640, end: 360 } }, envelope: { attack: 0.004, decay: 0.09 }, gain: 0.1 }),
  /** Jev finished ranking a search. */
  ranked: defineSound(chime([880, 1318.5], 0.07, 0.1)),
  /** A watch topic matched a new tweet. */
  alert: defineSound(chime([659.3, 880, 1318.5], 0.09, 0.13)),
  success: defineSound(chime([523.3, 784], 0.06, 0.12)),
  error: defineSound({ source: { type: "square", frequency: { start: 220, end: 160 } }, filter: { type: "lowpass", frequency: 900 }, envelope: { decay: 0.16 }, gain: 0.06 }),
}

export type SoundName = keyof typeof SOUNDS

let enabled = true
let ready = false

export function setSoundPrefs(on: boolean, volume: number) {
  enabled = on
  setMasterVolume(Math.max(0, Math.min(1, volume)))
}

export function play(name: SoundName) {
  if (!enabled) return
  // Before the first click Chrome holds audio back, then plays everything queued at once. Skip instead.
  if (!navigator.userActivation?.hasBeenActive) return
  if (ready) {
    SOUNDS[name]()
    return
  }
  // Browsers only start audio after a user gesture; the first sound waits for it.
  void ensureReady().then(() => {
    ready = true
    SOUNDS[name]()
  }, () => {})
}

// Warm the audio context on the first interaction so the first real sound isn't late.
window.addEventListener(
  "pointerdown",
  () => void ensureReady().then(() => (ready = true), () => {}),
  { once: true, capture: true },
)
