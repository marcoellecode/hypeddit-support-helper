// Cruscotto web locale: tutto si configura e si usa da qui (nessun file da modificare).
// L'automazione vera gira in automate.js (Playwright sul tuo profilo loggato).
// Impostazioni e stato (tracce gia' scaricate) sono salvati in ./data.
import path from "path"
import fs from "fs"
import crypto from "crypto"
import http from "http"
import net from "net"
import { spawn } from "child_process"
import express from "express"
import { fileURLToPath } from "url"
import {
  processTrack,
  requestStop,
  resetStop,
  pauseBetweenTracks,
  closeBrowser,
  openLoginWindow,
  closeLoginWindow,
  loginSiteOpen,
  remoteLoginActive,
  novncPort,
  checkAccounts,
  verifyAccount,
  loginWindowOpen,
  resolveChannel,
  CHANNEL_LABEL,
  LOGIN_URLS,
  profileExists,
  browserOpen,
} from "./automate.js"
import { CONFIG, DEFAULTS } from "./config.js"
import { validate, applySettings, loadSettings, saveSettings, resetSelectors } from "./settings.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(__dirname, CONFIG.dataDir)
fs.mkdirSync(dataDir, { recursive: true })
const stateFile = path.join(dataDir, "state.json")
const logFile = path.join(dataDir, "log.txt")
loadSettings(dataDir)

// Rete: di default solo localhost. In Docker: HSH_HOST=0.0.0.0 (gia' impostato nell'immagine).
// Il token API e' FACOLTATIVO (HSH_API_TOKEN): senza, chiunque sulla tua rete puo' usare l'app.
const PORT = Number(process.env.HSH_PORT) || 5178
const HOST = process.env.HSH_HOST || "127.0.0.1"
const URL_HOME = `http://localhost:${PORT}`
const LOCAL_ONLY = ["127.0.0.1", "localhost", "::1"].includes(HOST)
const API_TOKEN = process.env.HSH_API_TOKEN || ""
const extraHosts = new Set((process.env.HSH_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
if (!LOCAL_ONLY && !API_TOKEN) {
  console.log(
    "\n  NOTA: nessun token API impostato: chiunque sulla tua rete puo' usare l'app e i tuoi account.\n" +
      "  Va bene su una rete di casa fidata; per proteggerla imposta HSH_API_TOKEN (facoltativo).\n"
  )
}

// url -> { status, file, at }  (persistito su disco)
let history = {}
try {
  history = JSON.parse(fs.readFileSync(stateFile, "utf8"))
} catch {}
const saveHistory = () => fs.writeFileSync(stateFile, JSON.stringify(history, null, 2))

// Coda persistente (data/queue.json): sopravvive ai riavvii. `current` e' la traccia in
// lavorazione: se l'app si chiude a meta' viene rimessa in testa alla coda.
const URL_OK = /^https?:\/\/(www\.)?hypeddit\.com\/\S+$/i
const queueFile = path.join(dataDir, "queue.json")
let queue = [] // [{ url, addedAt, source }]
try {
  const raw = JSON.parse(fs.readFileSync(queueFile, "utf8"))
  queue = (raw.items || []).filter((q) => q && URL_OK.test(q.url))
  if (raw.current && URL_OK.test(raw.current.url)) queue.unshift(raw.current)
} catch {}
const saveQueue = () =>
  fs.writeFileSync(queueFile, JSON.stringify({ current: runningItem, items: queue }, null, 2))
let runningItem = null // { url, addedAt, source } della traccia in lavorazione

// account collegati (stato dedotto dai cookie del profilo), persistito su disco
const accountsFile = path.join(dataDir, "accounts.json")
let accounts = { soundcloud: null, spotify: null, instagram: null } // null = non verificato
try {
  accounts = { ...accounts, ...JSON.parse(fs.readFileSync(accountsFile, "utf8")) }
} catch {}
let checkedAt = null
async function refreshAccounts() {
  try {
    accounts = await checkAccounts()
    checkedAt = new Date().toISOString()
    if (state.alert?.site && accounts[state.alert.site] === true) state.alert = null // risolto
    fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2))
    return accounts
  } catch (e) {
    log(`Verifica account non riuscita: ${e.message}`)
    throw e
  }
}

const app = express()

// Difesa dal DNS-rebinding (una pagina web esterna che prova a raggiungere l'app): l'header Host
// (e Origin, se presente) deve essere "locale". In rete NON serve configurare nulla: sono
// accettati gli indirizzi IP, i nomi senza punti e i suffissi di rete locale / Tailscale, cioe'
// quello che un sito esterno non puo' usare. La porta non conta (puo' essere rimappata dall'host).
const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")
const hostOk = (hostHeader) => {
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(hostHeader || "").toLowerCase())
  if (!m) return false
  const name = m[1].replace(/^\[|\]$/g, "")
  if (name === "localhost" || name === "127.0.0.1" || name === "::1" || extraHosts.has(name)) return true
  if (LOCAL_ONLY) return false
  return isIp(name) || !name.includes(".") || /\.(local|lan|home\.arpa|internal|ts\.net)$/.test(name)
}
app.use((req, res, next) => {
  if (!hostOk(req.headers.host)) return res.status(403).end("host non consentito")
  const origin = req.headers.origin
  if (origin) {
    let h = ""
    try { h = new URL(origin).host } catch {}
    if (!hostOk(h)) return res.status(403).end("origin non consentito")
  }
  next()
})

// Token opzionale per l'API: se HSH_API_TOKEN e' impostato, ogni /api/* (tranne /api/health)
// richiede "Authorization: Bearer <token>" oppure l'header "X-API-Key".
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest()
app.use("/api", (req, res, next) => {
  if (!API_TOKEN || req.path === "/health") return next()
  const h = req.headers.authorization || ""
  const given = h.startsWith("Bearer ") ? h.slice(7).trim() : String(req.headers["x-api-key"] || "")
  if (given && crypto.timingSafeEqual(sha(given), sha(API_TOKEN))) return next()
  res.status(401).json({ error: "Token API mancante o errato" })
})
app.use(express.json())
app.use(express.text({ type: "text/plain", limit: "1mb" })) // curl -d "https://hypeddit.com/..."
app.use(express.static(path.join(__dirname, "public")))

// stato in memoria per l'interfaccia
const state = {
  running: false,
  stopping: false,
  alert: null, // es. { type:"account-expired", site, message, at }: la coda si e' fermata
  logs: [],
  queue: [],
  done: [],
  skipped: [],
  failed: [],
  current: null,
}
const log = (msg) => {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  state.logs.push(line)
  if (state.logs.length > 500) state.logs.shift()
  fs.appendFile(logFile, line + "\n", () => {})
  console.log(line)
}

const publicSettings = () => ({
  name: CONFIG.name,
  email: CONFIG.email,
  comment: CONFIG.comment,
  downloadDir: CONFIG.downloadDir,
  showBrowser: CONFIG.showBrowser,
  autoStart: CONFIG.autoStart,
  betweenTracksMs: CONFIG.betweenTracksMs,
  betweenTracksJitterMs: CONFIG.betweenTracksJitterMs,
  maxTracksPerRun: CONFIG.maxTracksPerRun,
  browserChannel: CONFIG.browserChannel,
  sel: CONFIG.sel,
})

app.get("/api/status", (_req, res) =>
  res.json({
    ...state,
    pending: queue.map((q) => q.url),
    emailSet: !!(CONFIG.name && CONFIG.email),
    accounts,
    checkedAt,
    loginWindowOpen: loginWindowOpen(),
    loginSite: loginSiteOpen(),
    remoteLogin: remoteLoginActive(),
    protected: !!API_TOKEN, // true = serve il token API
    networkOpen: !LOCAL_ONLY, // true = raggiungibile dalla rete (non solo da questo PC)
    browserOpen: browserOpen(),
    browserUsed: CHANNEL_LABEL[resolveChannel()],
    history,
  })
)

// ---------- Impostazioni ----------
app.get("/api/settings", (_req, res) => res.json({ settings: publicSettings(), defaults: DEFAULTS }))

app.post("/api/settings", async (req, res) => {
  const { value, error } = validate(req.body || {})
  if (error) return res.status(400).json({ error })
  const channelChanged = value.browserChannel && value.browserChannel !== CONFIG.browserChannel
  applySettings(value)
  saveSettings(dataDir)
  // il nuovo browser vale dal prossimo avvio; se la coda gira non lo chiudo
  if (channelChanged && !state.running) await closeBrowser()
  res.json({
    ok: true,
    settings: publicSettings(),
    note: state.running && channelChanged ? "Il cambio di browser vale dal prossimo avvio" : undefined,
  })
})

app.post("/api/settings/reset-selectors", (_req, res) => {
  resetSelectors()
  saveSettings(dataDir)
  res.json({ ok: true, settings: publicSettings() })
})

// ---------- Account / cartelle ----------
// Il login si fa in una finestra Chrome/Edge NORMALE (non pilotata): Google e altri
// rifiutano l'accesso dai browser automatizzati. Stesso profilo usato poi dalla coda.
app.post("/api/accounts/:site/login", async (req, res) => {
  const site = req.params.site
  if (!LOGIN_URLS[site]) return res.status(404).json({ error: "Account sconosciuto" })
  if (state.running) return res.status(409).json({ error: "Coda in esecuzione: fermala per accedere a un account" })
  try {
    // se la finestra e' gia' aperta la RIAPRE (non e' mai un errore)
    const info = await openLoginWindow(site, log, () => refreshAccounts().catch(() => {}))
    res.json({ ok: true, ...info })
  } catch (e) {
    res.status(/si sta aprendo/.test(e.message) ? 409 : 500).json({ error: e.message })
  }
})

// Chiude il login anche se la finestra e' "rimasta aperta" (es. hai chiuso solo la scheda dello
// schermo remoto): termina il browser e lo schermo remoto e riverifica gli account.
app.post("/api/login/close", (_req, res) => {
  const closed = closeLoginWindow(log)
  res.json({ ok: true, closed })
})

app.post("/api/accounts/check", async (_req, res) => {
  if (state.running) return res.status(409).json({ error: "Coda in esecuzione: verifica a fine coda" })
  try {
    res.json({ ok: true, accounts: await refreshAccounts() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post("/api/open-downloads", (_req, res) => {
  const dir = path.resolve(__dirname, CONFIG.downloadDir)
  fs.mkdirSync(dir, { recursive: true })
  if (process.platform === "win32") spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref()
  res.json({ ok: true, dir })
})

app.post("/api/clear-history", (_req, res) => {
  if (state.running) return res.status(409).json({ error: "Ferma la coda prima" })
  history = {}
  saveHistory()
  res.json({ ok: true })
})

// ---------- Coda ----------
// Avvisi verso l'esterno (opzionale): HSH_WEBHOOK_URL riceve un POST JSON per gli eventi
// "account-expired" e "queue-finished". Un errore del webhook non ferma mai l'app.
async function notify(event, data = {}) {
  const url = process.env.HSH_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "hypeddit-support-helper", event, at: new Date().toISOString(), ...data }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    log(`Webhook non raggiunto: ${e.message}`)
  }
}

// Una traccia e' fallita per un sito social: l'account e' davvero scaduto? (false = si')
async function accountExpired(site) {
  try {
    return (await verifyAccount(site)) === false
  } catch {
    return false
  }
}

// Accoda URL. Ritorna { added, duplicates, alreadyDownloaded, invalid } (liste di URL).
// Funziona anche mentre la coda gira: il worker prende i nuovi link appena puo'.
function enqueue(rawUrls, { skipDone = true, source = "api" } = {}) {
  const res = { added: [], duplicates: [], alreadyDownloaded: [], invalid: [] }
  const seen = new Set(queue.map((q) => q.url))
  if (runningItem) seen.add(runningItem.url)
  for (const raw of rawUrls) {
    const url = String(raw ?? "").trim()
    if (!url) continue
    if (!URL_OK.test(url)) res.invalid.push(url)
    else if (seen.has(url)) res.duplicates.push(url)
    else if (skipDone && history[url]?.status === "downloaded") res.alreadyDownloaded.push(url)
    else {
      seen.add(url)
      queue.push({ url, addedAt: new Date().toISOString(), source })
      res.added.push(url)
      if (state.running) state.queue.push(url) // conta nel totale dell'esecuzione in corso
    }
  }
  if (res.added.length) {
    saveQueue()
    log(`In coda +${res.added.length} (${source}), totale in attesa ${queue.length}`)
  }
  return res
}

// Estrae gli URL da un body JSON ({urls:[...]} / {url}) o testo semplice (uno per riga)
function urlsFromBody(body) {
  if (typeof body === "string") return body.split(/[\s,]+/).filter(Boolean)
  const b = body || {}
  const out = []
  if (Array.isArray(b.urls)) out.push(...b.urls)
  else if (typeof b.urls === "string") out.push(...b.urls.split(/[\s,]+/).filter(Boolean))
  if (b.url) out.push(b.url)
  return out
}

// Worker: lavora la coda in sequenza finche' ce n'e' e nessuno chiede lo stop.
// Ritorna false se gia' in corso o coda vuota.
function startWorker() {
  if (state.running || !queue.length) return false
  Object.assign(state, { running: true, stopping: false, alert: null, queue: queue.map((q) => q.url), done: [], skipped: [], failed: [], current: null })
  resetStop()
  if (!CONFIG.name || !CONFIG.email) log("Nome/email non impostati: le tracce con step email saranno segnate \"da fare a mano\"")
  ;(async () => {
    let processed = 0
    let expiredSite = null
    try {
      while (queue.length && !state.stopping) {
        if (CONFIG.maxTracksPerRun > 0 && processed >= CONFIG.maxTracksPerRun) {
          log(`Tetto di ${CONFIG.maxTracksPerRun} tracce per esecuzione: ${queue.length} restano in coda`)
          break
        }
        const item = queue.shift()
        runningItem = item
        state.current = item.url
        saveQueue()
        let stopped = false
        try {
          const r = await processTrack(item.url, log)
          // fallita per un sito social: se l'account e' scaduto, fermo la coda (la traccia
          // non e' colpa sua) invece di segnare "da fare a mano" tutte quelle che seguono
          if (r.status === "needs-manual" && r.site && (await accountExpired(r.site))) {
            expiredSite = r.site
            accounts[r.site] = false
            try { fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2)) } catch {}
            stopped = true
          } else {
            history[item.url] = { status: r.status, file: r.file || null, reason: r.reason || null, at: new Date().toISOString() }
            saveHistory()
          }
          if (expiredSite) {
            /* gestita dopo il ciclo */
          } else if (r.status === "downloaded") state.done.push(item.url)
          else if (r.status === "stopped") stopped = true
          else {
            state.failed.push(item.url)
            log(r.status === "needs-manual" ? `Saltata (da fare a mano): ${r.reason}` : `ATTENZIONE: nessun download per ${item.url}`)
          }
        } catch (e) {
          state.failed.push(item.url)
          history[item.url] = { status: "error", file: null, error: e.message, at: new Date().toISOString() }
          saveHistory()
          log(`ERRORE su ${item.url}: ${e.message}`)
        }
        runningItem = null
        state.current = null
        if (stopped) queue.unshift(item) // interrotta a meta': resta in testa alla coda
        saveQueue()
        if (stopped) break
        processed++
        if (queue.length && !state.stopping) await pauseBetweenTracks(log)
      }
    } finally {
      runningItem = null
      state.current = null
      state.running = false
      saveQueue()
      if (expiredSite) {
        const name = { soundcloud: "SoundCloud", spotify: "Spotify", instagram: "Instagram" }[expiredSite]
        const message = `Account ${name} scaduto o non collegato: coda ferma con ${queue.length} link in attesa. Rifai l'accesso (Impostazioni > Account) e riavvia.`
        state.alert = { type: "account-expired", site: expiredSite, message, at: new Date().toISOString() }
        log(`ACCOUNT SCADUTO - ${message}`)
        notify("account-expired", { site: expiredSite, pending: queue.length, message })
      } else {
        log(
          `${state.stopping ? "Interrotto" : "Coda completata"}. Scaricate ${state.done.length}, senza download ${state.failed.length}` +
            (queue.length ? `, ancora in coda ${queue.length}` : "") + "."
        )
        if (!state.stopping) notify("queue-finished", { done: state.done.length, failed: state.failed.length, pending: queue.length })
      }
    }
  })()
  return true
}

const stopWorker = () => {
  if (!state.running) return false
  state.stopping = true
  requestStop()
  log("Stop richiesto: mi fermo alla fine dello step corrente")
  return true
}

const startedInfo = () => ({ running: state.running, pending: queue.length })

// ---- API: coda ----
// Aggiungi link (anche a coda in esecuzione). start:true (o impostazione autoStart) la avvia.
app.post("/api/queue", (req, res) => {
  const urls = urlsFromBody(req.body)
  if (!urls.length) return res.status(400).json({ error: 'Nessun URL: manda {"urls":["https://hypeddit.com/..."]} oppure {"url":"..."}' })
  const skipDone = !(req.body && typeof req.body === "object" && req.body.skipDone === false)
  const source = (req.body && typeof req.body === "object" && String(req.body.source || "").slice(0, 40)) || "api"
  const r = enqueue(urls, { skipDone, source })
  if (!r.added.length && !r.duplicates.length && !r.alreadyDownloaded.length) {
    return res.status(400).json({ error: "Nessun URL hypeddit.com valido", ...r })
  }
  const wantStart = req.body && typeof req.body === "object" && req.body.start === true
  const started = (wantStart || CONFIG.autoStart) && r.added.length ? startWorker() : false
  res.status(r.added.length ? 201 : 200).json({ ok: true, ...r, started, ...startedInfo() })
})

app.get("/api/queue", (_req, res) =>
  res.json({
    running: state.running,
    stopping: state.stopping,
    current: runningItem,
    pending: queue,
    count: queue.length,
    autoStart: CONFIG.autoStart,
    run: { done: state.done, failed: state.failed },
  })
)

// Toglie link dalla coda (non tocca la traccia in lavorazione): ?url=... oppure svuota tutto
app.delete("/api/queue", (req, res) => {
  const only = req.query.url ? String(req.query.url) : null
  const before = queue.length
  const removed = new Set()
  queue = queue.filter((q) => {
    const drop = !only || q.url === only
    if (drop) removed.add(q.url)
    return !drop
  })
  state.queue = state.queue.filter((u) => !removed.has(u) || state.done.includes(u) || state.failed.includes(u) || u === state.current)
  saveQueue()
  if (only && !removed.size) return res.status(404).json({ error: "URL non presente in coda" })
  if (removed.size) log(`Tolti dalla coda: ${removed.size}`)
  res.json({ ok: true, removed: before - queue.length, ...startedInfo() })
})

// Avvia la coda. Se nel body ci sono URL (come /api/start) li accoda prima.
const startHandler = (req, res) => {
  if (state.running) return res.status(409).json({ error: "Gia' in esecuzione", ...startedInfo() })
  let r = null
  const urls = urlsFromBody(req.body)
  if (urls.length) {
    r = enqueue(urls, { skipDone: !(req.body && req.body.skipDone === false), source: "api" })
    if (!r.added.length && !queue.length) {
      return res.status(400).json({
        error: r.alreadyDownloaded.length ? "Tutte le tracce risultano gia' scaricate" : "Nessun URL hypeddit.com valido",
        ...r,
      })
    }
  }
  if (!queue.length) return res.status(400).json({ error: "Coda vuota" })
  startWorker()
  res.json({ ok: true, count: state.queue.length, skipped: r ? r.alreadyDownloaded.length : 0, ...(r || {}), ...startedInfo() })
}
app.post("/api/start", startHandler)
app.post("/api/queue/start", startHandler)

const stopHandler = (_req, res) => res.json({ ok: true, stopping: stopWorker(), ...startedInfo() })
app.post("/api/stop", stopHandler)
app.post("/api/queue/stop", stopHandler)

// Rimette in coda le tracce non scaricate (default: da fare a mano, senza download, errore, interrotte)
app.post("/api/queue/retry", (req, res) => {
  const statuses = Array.isArray(req.body?.statuses) && req.body.statuses.length
    ? req.body.statuses.map(String)
    : ["needs-manual", "no-download", "error", "stopped"]
  const urls = Object.entries(history).filter(([, v]) => statuses.includes(v.status)).map(([u]) => u)
  const r = enqueue(urls, { skipDone: false, source: "retry" })
  const started = req.body?.start === true || CONFIG.autoStart ? (r.added.length ? startWorker() : false) : false
  res.json({ ok: true, ...r, started, ...startedInfo() })
})

// ---- API: cronologia, log, download, account ----
app.get("/api/history", (req, res) => {
  const only = req.query.status ? String(req.query.status).split(",") : null
  const items = Object.entries(history)
    .map(([url, v]) => ({ url, ...v }))
    .filter((v) => !only || only.includes(v.status))
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
  res.json({ count: items.length, items })
})

app.get("/api/log", (req, res) => {
  const n = Math.min(500, Math.max(1, Number(req.query.lines) || 100))
  res.json({ lines: state.logs.slice(-n) })
})

app.get("/api/accounts", (_req, res) =>
  res.json({ accounts, checkedAt, emailSet: !!(CONFIG.name && CONFIG.email), loginWindowOpen: loginWindowOpen() })
)

const downloadsDir = () => path.resolve(__dirname, CONFIG.downloadDir)
app.get("/api/downloads", (_req, res) => {
  let files = []
  try {
    files = fs
      .readdirSync(downloadsDir(), { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const st = fs.statSync(path.join(downloadsDir(), d.name))
        return { name: d.name, bytes: st.size, modifiedAt: st.mtime.toISOString() }
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {}
  res.json({ dir: downloadsDir(), count: files.length, files })
})
app.get("/api/downloads/:name", (req, res) => {
  const name = req.params.name
  const full = path.join(downloadsDir(), name)
  if (path.basename(name) !== name || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return res.status(404).json({ error: "File non trovato" })
  }
  res.download(full)
})

app.get("/api/health", (_req, res) => res.json({ ok: true, running: state.running, pending: queue.length }))

// ---------- Schermo remoto (login in Docker) ----------
// websockify/noVNC ascolta solo su 127.0.0.1 dentro il container; qui lo ripropongo sotto
// /novnc sulla STESSA porta dell'app: nessuna seconda porta da pubblicare o rimappare.
const upstreamHeaders = (headers) => ({ ...headers, host: `127.0.0.1:${novncPort()}` })
app.use("/novnc", (req, res) => {
  if (!remoteLoginActive()) {
    return res.status(503).type("text/plain").end("Schermo remoto non attivo: premi Accedi su un account nelle Impostazioni.")
  }
  const up = http.request(
    { host: "127.0.0.1", port: novncPort(), path: req.url, method: req.method, headers: upstreamHeaders(req.headers) },
    (pr) => {
      res.writeHead(pr.statusCode || 502, pr.headers)
      pr.pipe(res)
    }
  )
  up.on("error", () => { if (!res.headersSent) res.status(502).type("text/plain").end("Schermo remoto non ancora pronto: riprova tra un attimo.") })
  req.pipe(up)
})

// Indice dell'API (autodescrittivo)
app.get("/api", (_req, res) =>
  res.json({
    auth: API_TOKEN ? "Authorization: Bearer <HSH_API_TOKEN> oppure X-API-Key" : "nessuna (token facoltativo: HSH_API_TOKEN)",
    endpoints: [
      "GET    /api/health",
      "GET    /api/status",
      "GET    /api/queue",
      "POST   /api/queue            {urls|url, start?, skipDone?}   oppure testo semplice",
      "DELETE /api/queue[?url=...]",
      "POST   /api/queue/start      {urls?}",
      "POST   /api/queue/stop",
      "POST   /api/queue/retry      {statuses?, start?}",
      "GET    /api/history[?status=downloaded,needs-manual]",
      "GET    /api/log[?lines=100]",
      "GET    /api/accounts",
      "POST   /api/accounts/check",
      "POST   /api/accounts/:site/login   (riapre il login se gia' aperto)",
      "POST   /api/login/close",
      "GET    /api/settings",
      "POST   /api/settings",
      "GET    /api/downloads",
      "GET    /api/downloads/:name",
    ],
  })
)

// JSON malformato e simili: risposta JSON invece della pagina HTML di Express
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.type === "entity.parse.failed" ? "JSON non valido" : String(err.message || err) })
})

// ---------- Avvio: apre da solo l'interfaccia grafica ----------
function openInBrowser() {
  if (process.env.NO_OPEN) return
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", URL_HOME], { detached: true, stdio: "ignore" }).unref()
  }
}

// solo localhost: il cruscotto pilota i tuoi account, non deve essere raggiungibile dalla rete
const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Cruscotto pronto: ${URL_HOME}${LOCAL_ONLY ? "" : `  (in ascolto su ${HOST}:${PORT})`}\n`)
  openInBrowser()
  if (queue.length) {
    log(`Coda ripresa dal disco: ${queue.length} link in attesa`)
    if (CONFIG.autoStart) startWorker()
  }
})
// WebSocket di noVNC (/novnc/websockify): inoltro "grezzo" verso websockify locale
server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/novnc/") || !hostOk(req.headers.host) || !remoteLoginActive()) return socket.destroy()
  const up = net.connect(novncPort(), "127.0.0.1", () => {
    const CRLF = "\r\n"
    let raw = `${req.method} ${req.url.slice("/novnc".length)} HTTP/1.1${CRLF}`
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]
      const value = name.toLowerCase() === "host" ? `127.0.0.1:${novncPort()}` : req.rawHeaders[i + 1]
      raw += `${name}: ${value}${CRLF}`
    }
    up.write(raw + CRLF)
    if (head && head.length) up.write(head)
    socket.pipe(up)
    up.pipe(socket)
  })
  up.on("error", () => socket.destroy())
  socket.on("error", () => up.destroy())
})

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`\n  Il cruscotto e' gia' aperto su ${URL_HOME}: lo riapro nel browser.\n`)
    openInBrowser()
    setTimeout(() => process.exit(0), 500)
  } else throw e
})

// Chiusura pulita (Ctrl+C oppure `docker stop` = SIGTERM): la traccia in lavorazione e'
// gia' salvata in queue.json come "current" e riparte da capo al prossimo avvio (le azioni
// gia' fatte vengono riconosciute come attive e non ripetute).
let shuttingDown = false
const shutdown = async (sig) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n  ${sig}: chiusura...`)
  try { saveQueue() } catch {}
  await Promise.race([closeBrowser(), new Promise((r) => setTimeout(r, 4000))])
  server.close()
  process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
