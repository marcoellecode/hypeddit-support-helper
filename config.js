// Valori PREDEFINITI. Non serve piu' modificarli a mano: tutto si configura
// dalla scheda "Impostazioni" del cruscotto e viene salvato in data/settings.json.
export const DEFAULTS = {
  name: "",
  email: "",
  comment: "support", // il commento che usi di solito

  // Cartella dove vengono salvati i download (relativa all'app o percorso assoluto)
  downloadDir: process.env.HSH_DOWNLOAD_DIR || "./downloads",

  // Cartella per stato della coda, log e impostazioni
  dataDir: process.env.HSH_DATA_DIR || "./data",

  // false = headless: nessuna finestra, nessuna interazione. true = mostra il browser
  // (solo per diagnostica: non cambia il comportamento, nessuno step viene atteso a mano)
  showBrowser: false,

  // Ritmo "umano": pausa tra una traccia e la successiva = base + casuale(0..jitter)
  betweenTracksMs: 8000,
  betweenTracksJitterMs: 6000,

  // Tetto di tracce per singola esecuzione (0 = nessun limite). Le altre restano in coda.
  maxTracksPerRun: 25,

  // true = quando un link arriva via API e la coda e' ferma, parte da sola
  autoStart: false,

  // "auto" (Chrome se presente, altrimenti Edge), "chrome", "msedge" oppure "chromium"
  // (Playwright: NON adatto al login con Google, che lo rifiuta)
  browserChannel: "auto",

  // Selettori del gate Hypeddit — modificabili in Impostazioni > Avanzate
  sel: {
    getTrackButton: "#downloadProcess",
    stepContainer: "#myCarousel",
    currentStep: ".fangate-slider-content:not(.move-left)",
    emailName: "#email_name",
    emailAddress: "#email_address",
    emailNext: "#email_to_downloads_next",
    scComment: "#sc_comment_text",
    downloadButton: "#gateDownloadButton",
  },
}

// Oggetto "vivo": settings.js lo aggiorna e automate.js lo legge a ogni traccia.
export const CONFIG = structuredClone(DEFAULTS)
