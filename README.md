# Hypeddit Support Helper

[![Controlli e immagine Docker](https://github.com/marcoellecode/hypeddit-support-helper/actions/workflows/docker.yml/badge.svg)](https://github.com/marcoellecode/hypeddit-support-helper/actions/workflows/docker.yml)
[![Licenza: MIT](https://img.shields.io/badge/licenza-MIT-blue.svg)](LICENSE)

**Supporta davvero molti artisti su Hypeddit, senza fare a mano gli stessi clic cento volte.**

Hypeddit è la piattaforma dove gli artisti offrono tracce in download gratuito in cambio di un
piccolo gesto di supporto (il *download gate*): seguire l'artista su SoundCloud, mettere like,
fare repost, lasciare un commento, collegare Spotify, seguire su Instagram, lasciare l'email.
Questo programma automatizza **i passaggi meccanici e ripetitivi** di quel percorso, ma
**compie le azioni reali** con i tuoi account. L'artista riceve esattamente ciò che riceverebbe
se avessi cliccato tu.

> 🇮🇹 Documentazione in italiano. Interfaccia e messaggi dell'app sono in italiano.

---

## Perché esiste

Se ami la musica e scarichi spesso tracce dai gate, il percorso è sempre lo stesso: apri la
pagina, premi "Get this track", segui su SoundCloud, like, repost, commento, autorizza
Spotify, segui su Instagram, inserisci l'email, aspetta, scarica. Per **una** traccia sono
2-3 minuti di clic identici. Per venti tracce è una serata.

Esistono strumenti che "risolvono" il problema **aggirando il gate**: leggono il link
diretto del file e lo scaricano senza compiere nessuna azione, oppure marcano gli step come
"fatti" nella pagina senza che il follow esista davvero. Funzionano, ma **tolgono all'artista
proprio ciò per cui ha messo il gate**: il follow, il like, il repost.

Questo progetto nasce con l'idea opposta:

> **Fare tutto ciò che farebbe una persona, solo più in fretta e senza noiosa ripetizione.**
> Le azioni sono vere, con account veri. Lo stato del gate non viene **mai** falsificato.

Il tempo che si risparmia serve a **scoprire e supportare più artisti**, non a evitare di
supportarli. Questa è la regola di progetto irrinunciabile, ed è anche ciò che distingue
l'app da un bypass: se un passaggio non si può fare in modo autentico, l'app **non lo
inventa**: segna la traccia "da fare a mano" e va avanti.

## Cosa fa

- 🎯 **Percorre il gate da sola**, step per step: email, SoundCloud, Spotify, Instagram, download.
- 🤝 **Azioni vere e verificate**: follow, like, repost, commento su SoundCloud; consenso su
  Spotify; follow su Instagram. Se un'azione è già attiva **non la tocca** (non toglie mai un
  like o un follow esistente) e dopo ogni clic controlla che sia andata a buon fine.
- 💬 **Commento** con il testo che scegli (di solito *"support"*), pubblicato **una volta sola**
  per brano anche se rilanci la coda.
- 🖥️ **Tutto in background, senza interazione** durante la coda: nessuna finestra, nessuna
  conferma. L'unica cosa manuale è accedere ai tuoi account **una volta**.
- 📋 **Coda persistente**: incolli (o mandi via API) i link; sopravvive ai riavvii.
- 🌐 **Cruscotto web** per configurare tutto, vedere log ed esiti, e **API REST** completa
  (con la documentazione anche dentro l'interfaccia, scheda *API*).
- 🧯 **Si ferma quando serve**: se un account social scade, la coda si ferma con un avviso
  (e un webhook opzionale) invece di bruciare tutti i link segnandoli come falliti.
- 🧑‍🎤 **Ritmo "umano"**: pause casuali tra le tracce e un tetto di tracce per esecuzione.
- 🐳 **Docker**: gira su un server (NAS, mini-PC, ZimaOS…) con login degli account tramite
  schermo remoto nel browser.

### Cosa NON fa (di proposito)

- ❌ Non aggira il gate e non scarica "di nascosto".
- ❌ Non falsifica follow, like o step completati.
- ❌ Non è pensato per account fittizi: perderebbe il senso del supporto reale.
- ❌ Non risolve captcha né bypassa controlli anti-bot.

## Come funziona

```
  Tu / script / altre app
        │  link Hypeddit (cruscotto web oppure API REST)
        ▼
  ┌───────────────────────────┐
  │  Server Node + Express    │  coda persistente, log, cronologia, API
  └─────────────┬─────────────┘
                │ Playwright (browser headless con il TUO profilo già loggato)
                ▼
     hypeddit.com ── gate: email · download
     soundcloud.com ─ follow · like · repost · commento   (azioni REALI)
     spotify.com ──── consenso (Hypeddit segue l'artista/playlist)
     instagram.com ── follow
                │
                ▼
          cartella download
```

Per ogni traccia l'app apre il gate, legge lo step corrente e agisce di conseguenza. Ogni
azione social avviene nel popup che il gate stesso apre, con il tuo account. Dopo ogni
azione l'app verifica lo stato reale (es. il pulsante diventa "Segui già") prima di andare
avanti. Gli step che non sa fare in modo autentico (Facebook, YouTube, TikTok…) fanno finire la
traccia in **"da fare a mano"** con il motivo, e la coda prosegue.

> **Perché un browser vero e non una pagina web?** Una pagina servita in locale non può agire su
> hypeddit.com né sulle tue sessioni di SoundCloud o Spotify (Same-Origin Policy del browser).
> Per questo l'app pilota un vero browser con Playwright, in un profilo dedicato.

---

## Installazione

### Opzione A — sul tuo PC Windows (come uno strumento "scarica e avvia")

Serve [Node.js](https://nodejs.org) 20 o superiore (LTS, oppure `winget install OpenJS.NodeJS.LTS`)
e Google Chrome **oppure** Microsoft Edge.

**Scarica lo zip** dalle [Releases](https://github.com/marcoellecode/hypeddit-support-helper/releases/latest)
(`hypeddit-support-helper-windows.zip`), estrailo dove vuoi e fai **doppio clic su `avvia.cmd`**.
In alternativa: pulsante verde *Code → Download ZIP* sul repository, oppure da terminale:

```powershell
git clone https://github.com/marcoellecode/hypeddit-support-helper.git
cd hypeddit-support-helper
.vvia.cmd
```

`avvia.cmd` installa le dipendenze al primo avvio, parte il server e apre l'interfaccia su
`http://localhost:5178`. Per fermare l'app chiudi la finestra nera.

**Aggiornare:** scarica la nuova versione e sostituisci i file **tenendo le cartelle `data/`,
`user-profile/` e `downloads/`**: contengono impostazioni, login e file scaricati.

### Opzione B — su un server con Docker (x86-64, anche ZimaOS/CasaOS)

L'immagine è costruita automaticamente da GitHub Actions e pubblicata su GitHub Container
Registry. **Solo x86-64**: Google Chrome per Linux non esiste per ARM. **Non serve configurare nulla.**

```bash
mkdir hypeddit-support-helper && cd hypeddit-support-helper
curl -LO https://raw.githubusercontent.com/marcoellecode/hypeddit-support-helper/main/docker-compose.linux.yml
mkdir -p data downloads && sudo chown 1000:1000 data downloads
docker compose -f docker-compose.linux.yml up -d
```
Poi apri `http://<IP-del-server>:5178`.

- **ZimaOS / CasaOS:** importa in *Installazione personalizzata* il file `docker-compose.yml` della radice
  (già adattato: nome, icona, porta, dati in AppData), oppure aggiungi il repository come App Store di terze
  parti. `docker-compose.linux.yml` è invece per un server Linux generico (dettagli in
  [DOCKER.md](DOCKER.md#zimaos--casaos)).
- Il login degli account avviene da uno **schermo remoto aperto nel browser**, sulla stessa porta dell'app.
- Tutti i dettagli (porta diversa, primo accesso agli account, sicurezza, aggiornamenti, problemi):
  **[DOCKER.md](DOCKER.md)**.

---

## Primo utilizzo

1. Apri l'interfaccia ed entra in **Impostazioni → Account**.
2. Premi **Accedi** su SoundCloud, Spotify e Instagram (non sono obbligatori: ciò che non colleghi
   finisce in "da fare a mano"). Si apre un browser **normale** (non pilotato): accedi come
   sempre, anche con *Accedi con Google*, poi chiudilo. Su Docker lo stesso accade in uno
   schermo remoto aperto dal tuo browser.
3. Inserisci **nome ed email** per lo step email del gate, e il testo del **commento**.
4. Nella scheda **Coda** incolla i link (uno per riga) e premi **Avvia coda**.

Fatto: da qui non serve più toccare nulla. Log, esiti e screenshot diagnostici dei fallimenti
(`data/debug/`) ti dicono cosa è successo.

## Configurazione

Tutto si imposta dall'interfaccia (scheda *Impostazioni*) e viene salvato in `data/settings.json`:
pause tra le tracce, tetto di tracce, browser da usare, cartella download, commento, avvio
automatico quando arrivano link via API, selettori del gate (se Hypeddit cambia la pagina).

Variabili d'ambiente (**tutte facoltative**):

| Variabile | A cosa serve |
|---|---|
| `HSH_API_TOKEN` | Token per cruscotto e API. Facoltativo: se vuoto l'app si apre senza chiedere nulla (va bene su una rete di casa fidata). |
| `HSH_HOST`, `HSH_PORT` | Dove ascolta (default `127.0.0.1:5178`; nell'immagine Docker `0.0.0.0`). |
| `HSH_ALLOWED_HOSTS` | Solo per un dominio tuo (es. dietro un reverse proxy): l'host di rete locale/Tailscale è già accettato in automatico. |
| `HSH_VNC_PASSWORD` | Password fissa per lo schermo remoto (default: casuale a ogni login, passata nell'indirizzo). |
| `HSH_WEBHOOK_URL` | Riceve un POST JSON per `account-expired` e `queue-finished`. |
| `HSH_DATA_DIR`, `HSH_DOWNLOAD_DIR`, `HSH_PROFILE_DIR` | Cartelle di dati, download e profilo del browser. |
| `HSH_LOCALE` | Lingua del browser (default `it-IT`: gli step sono collaudati in italiano). |

## API

Puoi aggiungere link, avviare e fermare la coda, leggere esiti e log da script o altri
programmi. Esempio:

```bash
curl -X POST http://localhost:5178/api/queue \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hypeddit.com/artista/traccia","start":true}'
```

La documentazione completa, con esempi PowerShell/curl e un pulsante «Esegui», è nella
scheda **API** dell'interfaccia; il riferimento testuale è in **[API.md](API.md)**.

## Sicurezza

- Di default l'app ascolta **solo su `127.0.0.1`** (sul PC). In Docker è raggiungibile dalla rete:
  senza `HSH_API_TOKEN` **chiunque sulla tua rete può usarla** (e quindi usare i tuoi account), perciò va
  bene solo su una rete di casa fidata. Per proteggerla imposta il token (facoltativo). L'app lo segnala
  con un avviso in alto nell'interfaccia.
- Difesa automatica dal DNS-rebinding: accetta solo richieste con host locale (IP, nomi senza punti,
  `.local`, Tailscale…), senza nulla da configurare.
- **Non esporre la porta su internet**; da fuori casa usa una VPN (es. Tailscale).
- Il profilo del browser contiene i tuoi login: trattalo come una password. È escluso dal repository
  (`.gitignore`) e dall'immagine Docker.
- Lo schermo remoto per il login è protetto da una password casuale per sessione ed esiste solo mentre
  il login è aperto; non è cifrato: tienilo su rete fidata.
- Nessun dato viene inviato a terzi: l'app parla solo con Hypeddit e con i siti che pilota (più
  l'eventuale webhook che configuri tu).

## Limiti e onestà

- ⚠️ **Termini d'uso.** Automatizzare azioni sui propri account social va generalmente
  **contro i termini** di piattaforme come Instagram, Spotify e SoundCloud, che possono
  rilevare l'attività automatizzata. Con un uso intenso l'account può essere **limitato o
  segnalato**. Usa volumi moderati, tieni le pause "umane" e valuta il rischio: **lo usi a tua
  responsabilità**.
- 🔧 **Fragilità.** Dipende dal markup di Hypeddit e delle pagine social, che cambiano senza
  preavviso. I selettori del gate sono modificabili dall'interfaccia; per i siti social le
  correzioni vanno nel codice (`automate.js`).
- 🤖 **Browser headless.** È riconoscibile come tale e il progetto **non** usa trucchi per
  nasconderlo. Instagram in particolare può chiedere verifiche di sicurezza: in quel caso
  l'app ferma la coda (come per un account scaduto) e la risolvi tu dallo schermo.
- 🇮🇹 Gli step sono stati collaudati con le pagine in **italiano** (`HSH_LOCALE=it-IT`).
- 🧪 Stato: funziona end-to-end con account reali su Windows. L'immagine Docker è nuova:
  segnala qualsiasi problema aprendo una *issue*.

## Struttura del progetto

| File | Ruolo |
|---|---|
| `server.js` | Cruscotto web, coda persistente, worker, API REST, sicurezza di rete |
| `automate.js` | Logica Playwright: gate, azioni social, verifica degli account, login remoto |
| `settings.js`, `config.js` | Impostazioni, validazione e valori predefiniti |
| `public/index.html` | Interfaccia (Coda, Impostazioni, API) |
| `Dockerfile`, `docker-compose.yml` | Immagine e compose per ZimaOS / CasaOS |
| `docker-compose.linux.yml` | Compose per un server Linux generico |
| `Apps/HypedditSupportHelper/` | Pacchetto per ZimaOS / CasaOS (compose con metadati e icona) |
| `.github/workflows/docker.yml` | Controlli e pubblicazione dell'immagine su ghcr.io |
| `avvia.cmd` | Avvio con un doppio clic su Windows |
| `API.md`, `DOCKER.md` | Riferimento API e guida Docker |

## Contribuire

Segnalazioni e proposte sono benvenute (*issue* e *pull request*). Se uno step smette di
funzionare, allega il log e lo screenshot in `data/debug/` (controlla che non mostri dati
personali prima di condividerlo).

## Avvertenze

Progetto indipendente: **non è affiliato né approvato** da Hypeddit, SoundCloud, Spotify,
Instagram/Meta. I nomi appartengono ai rispettivi proprietari. Il software è fornito "così
com'è" (vedi [LICENSE](LICENSE)); l'autore non risponde di eventuali limitazioni o chiusure
degli account.

## Licenza

[MIT](LICENSE) © 2026 marcoellecode
