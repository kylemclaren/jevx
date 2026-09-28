/** Dashboard theme: follow the system, or pin light or dark. */
import { useSyncExternalStore } from "react"
export type Theme = "system" | "light" | "dark"

const KEY = "jevx-theme"
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)")
let current: Theme = readCached()

function readCached(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

export function applyTheme(theme: Theme) {
  current = theme
  const dark = theme === "dark" || (theme === "system" && prefersDark.matches)
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.style.colorScheme = dark ? "dark" : "light"
  try {
    // A per-browser cache so the next load paints in the right theme before settings arrive.
    localStorage.setItem(KEY, theme)
  } catch {
    // Private window or blocked storage: the setting in chrome.storage still applies.
  }
}

export function initTheme() {
  applyTheme(current)
  prefersDark.addEventListener("change", () => current === "system" && applyTheme("system"))
}

// ── resolved theme, for libraries that take "dark" | "light" ──────────────

const listeners = new Set<() => void>()
new MutationObserver(() => listeners.forEach((l) => l())).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

export function useResolvedTheme(): "dark" | "light" {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
  )
}
