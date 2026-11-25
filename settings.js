// Caricamento, validazione e salvataggio delle impostazioni (data/settings.json).
import fs from "fs"
import path from "path"
import { CONFIG, DEFAULTS } from "./config.js"

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max)
const num = (v, min, max, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

// Restituisce { value, error }: value contiene solo i campi validi e normalizzati.
export function validate(input) {
  const out = {}
  const errors = []
  if ("name" in input) out.name = str(input.name, 80)
  if ("email" in input) {
    const e = str(input.email, 120)
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) errors.push("Email non valida")
    else out.email = e
  }
  if ("comment" in input) out.comment = str(input.comment, 300)
  if ("downloadDir" in input) {
    const d = str(input.downloadDir, 300)
    if (!d) errors.push("Cartella download vuota")
    else out.downloadDir = d
  }
  if ("showBrowser" in input) out.showBrowser = !!input.showBrowser
  if ("autoStart" in input) out.autoStart = !!input.autoStart
  if ("betweenTracksMs" in input) out.betweenTracksMs = num(input.betweenTracksMs, 0, 600000, DEFAULTS.betweenTracksMs)
  if ("betweenTracksJitterMs" in input)
    out.betweenTracksJitterMs = num(input.betweenTracksJitterMs, 0, 600000, DEFAULTS.betweenTracksJitterMs)
  if ("maxTracksPerRun" in input) out.maxTracksPerRun = num(input.maxTracksPerRun, 0, 1000, DEFAULTS.maxTracksPerRun)
  if ("browserChannel" in input) {
    out.browserChannel = ["auto", "chromium", "chrome", "msedge"].includes(input.browserChannel)
      ? input.browserChannel
      : "auto"
  }
  if (input.sel && typeof input.sel === "object") {
    out.sel = {}
    for (const k of Object.keys(DEFAULTS.sel)) {
      if (k in input.sel) {
        const s = str(input.sel[k], 200)
        if (!s) errors.push(`Selettore "${k}" vuoto`)
        else out.sel[k] = s
      }
    }
  }
  return { value: out, error: errors.length ? errors.join(". ") : null }
}

export function applySettings(partial) {
  const { sel, ...rest } = partial
  Object.assign(CONFIG, rest)
  if (sel) Object.assign(CONFIG.sel, sel)
}

export function loadSettings(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"))
    const { value } = validate(raw)
    applySettings(value)
  } catch {}
}

export function saveSettings(dataDir) {
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(CONFIG, null, 2))
}

export function resetSelectors() {
  Object.assign(CONFIG.sel, DEFAULTS.sel)
}
