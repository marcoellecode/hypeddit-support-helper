# Docker (server Linux x86-64: NAS, mini-PC, ZimaOS…)

L'immagine viene costruita e pubblicata da GitHub Actions su
`ghcr.io/marcoellecode/hypeddit-support-helper` (solo `linux/amd64`: Google Chrome per Linux non
esiste per ARM). **Non serve configurare nulla**: si installa, si apre l'app e si collegano gli account.

## Cosa c'è
Un solo contenitore, `hypeddit-support-helper`:
- cruscotto + API su una **sola porta** (`5178` nel container, mappabile come vuoi sull'host);
- browser Google Chrome headless per la coda;
- **schermo remoto per il login** (Xvfb + x11vnc + noVNC), che si accende solo quando premi
  «Accedi» e passa **dalla stessa porta dell'app**: se cambi la porta sull'host funziona uguale;
- un volume per i dati (profilo del browser con i login, coda, cronologia, impostazioni) e una
  cartella per i download.

## Installazione con Docker Compose (server con terminale)
```bash
mkdir hypeddit-support-helper && cd hypeddit-support-helper
curl -LO https://raw.githubusercontent.com/marcoellecode/hypeddit-support-helper/main/docker-compose.linux.yml
mkdir -p data downloads && sudo chown 1000:1000 data downloads
docker compose -f docker-compose.linux.yml up -d
```
Poi apri `http://<IP-del-server>:5178`.

- Porta occupata? Apri `docker-compose.linux.yml` e cambia il numero **a sinistra** in `ports:` (es. `"8178:5178"`).
- Token, webhook e fuso orario si cambiano nello stesso file, sotto `environment:` (tutto facoltativo).
- Se l'immagine risulta privata (`pull access denied`): su GitHub, *Packages → hypeddit-support-helper →
  Package settings → Change visibility → Public*.
- Per costruirla sul posto invece di scaricarla: clona il repository, poi
  `docker build -t ghcr.io/marcoellecode/hypeddit-support-helper:latest .` e `docker compose up -d`.

## ZimaOS / CasaOS
Il file **`docker-compose.yml`** (quello della radice del repository) è già adattato a CasaOS: nome, descrizione,
icona, porta e dati in AppData. Indirizzo da importare:

`https://raw.githubusercontent.com/marcoellecode/hypeddit-support-helper/main/docker-compose.yml`

> Per un server Linux **generico** (non CasaOS) esiste `docker-compose.linux.yml`, con cartelle `./data` e
> `./downloads`. Non usarlo su ZimaOS/CasaOS: non sa interpretare quel formato.

**Metodo 1 — installazione personalizzata (il più semplice)**
1. *App Store → Installazione personalizzata (Custom Install)*.
2. Importa il file con l'indirizzo qui sopra (o incolla il contenuto del file). Quello in `Apps/` è identico.
3. Controlla che nel modulo ci siano porta **5178 → 5178** e i volumi `/data` e `/downloads` su
   `/DATA/AppData/hypeddit-support-helper/data` e `.../downloads` (come le altre app), poi **Installa**.
   Non c'è altro da cambiare; i download li vedi dall'app *File*, dentro `AppData/hypeddit-support-helper/downloads`.
   Per proteggere l'app con un token (facoltativo) aggiungi la variabile `HSH_API_TOKEN` dalle impostazioni dell'app.

**Metodo 2 — come App Store di terze parti**
*App Store → ⚙ → aggiungi sorgente* e inserisci
`https://github.com/marcoellecode/hypeddit-support-helper/archive/refs/heads/main.zip`.
L'app compare nell'elenco con la sua icona.

Se la porta 5178 è occupata, cambia **solo il numero della porta Host** nel modulo: tutto continua a
funzionare (anche lo schermo remoto), perché passa da quella unica porta.
Il container gira come root perché le cartelle `/DATA` di ZimaOS sono di root.

## Primo accesso agli account (una volta sola)
1. Apri l'app → **Impostazioni → Account → Accedi** (SoundCloud, Spotify, Instagram, uno alla volta).
2. Si apre una scheda con lo **schermo del server**. La password è già inserita nell'indirizzo
   (generata a caso a ogni login): non devi impostare niente.
3. Accedi come sul PC, **anche con Google** (è Chrome vero, non pilotato). Poi **chiudi Chrome** con la X
   della finestra **oppure** premi **«Chiudi login e verifica»** nella pagina dell'app.
4. Alla fine **Verifica collegamenti** deve mostrare «Collegato».

> **Hai chiuso per sbaglio la scheda dello schermo remoto?** Nessun problema: nelle Impostazioni
> compare «Finestra di login aperta» con i tasti **Riapri finestra** e **Chiudi login e verifica**; anche i
> tasti dei singoli account diventano «Riapri finestra». Non resti mai bloccato.

Il login resta nel volume dei dati: sopravvive a riavvii e aggiornamenti. Le sessioni sono quelle del
server (IP di casa), indipendenti da quelle del tuo PC.

## Sicurezza (token facoltativo)
Di default l'app si apre **senza token**: va bene su una rete di casa fidata. Chiunque raggiunga la porta
può però usare l'app (e quindi i tuoi account). Se vuoi proteggerla imposta `HSH_API_TOKEN`: cruscotto e
API chiederanno il token (l'interfaccia lo chiede una volta e lo ricorda).

- **Non esporre la porta su internet** e non aprire porte sul router. Per accedere da fuori casa usa una
  VPN (es. Tailscale).
- Il controllo dell'host è **automatico**: l'app accetta richieste con indirizzo IP, nome senza punti
  (`zimaos`), `.local`, `.lan`, `.home.arpa` o `.ts.net` (Tailscale), e rifiuta i nomi pubblici (difesa dal
  DNS-rebinding). Per un dominio tuo (es. dietro un reverse proxy) c'è la variabile facoltativa
  `HSH_ALLOWED_HOSTS`.
- Lo schermo remoto è protetto da una password casuale per sessione, ed esiste solo mentre il login è aperto.
- Il volume dei dati contiene i tuoi login: trattalo come una password.

## Uso
Dal cruscotto o dall'API (scheda **API** dell'interfaccia, oppure [`API.md`](API.md)):
```bash
curl -X POST http://<IP-del-server>:5178/api/queue -H "Content-Type: application/json" \
  -d '{"url":"https://hypeddit.com/artista/traccia","start":true}'
```
Per far partire la coda da sola quando arrivano link: Impostazioni → «Avvia la coda da sola…».

### Account scaduti
Se durante la coda un'azione social fallisce, l'app **verifica davvero** l'accesso a quel sito. Se è
scaduto **ferma la coda**, rimette la traccia in testa e mostra un avviso nel cruscotto e in
`GET /api/status` (`alert`); con `HSH_WEBHOOK_URL` fa anche un `POST` JSON (`account-expired`,
`queue-finished`). Rifai il login e riavvia: nessun link va perso.

## Comandi utili
```bash
docker compose ps                  # stato (c'è anche l'healthcheck)
docker compose logs -f             # log
docker compose restart             # riavvio (la coda riprende dal disco)
docker compose pull && docker compose up -d   # aggiornamento all'ultima versione
docker compose down                # ferma (i dati restano nel volume)
```

## Se qualcosa non va
```bash
docker compose exec hypeddit-support-helper sh -c 'ls -l /opt/google/chrome/chrome /usr/share/novnc/vnc.html; which Xvfb x11vnc websockify fluxbox'
curl -s http://<IP-del-server>:5178/api/health            # {"ok":true,...}
```
Nei log cerca le righe `Login remoto: … non parte`. Per i problemi scrivi una *issue* su GitHub con
l'output di `docker compose logs`.

## Limiti e rischi
- **Automatizzare azioni sui tuoi account va contro i termini di Instagram, SoundCloud e Spotify** e può
  far limitare l'account. L'app usa ritmi umani e un tetto di tracce.
- Un browser headless è riconoscibile come tale; non ci sono trucchi per nasconderlo.
- Instagram può chiedere una verifica di sicurezza: l'app ferma la coda come per un account scaduto;
  risolvila dallo schermo remoto (Accedi) e riavvia.
- Lo schermo remoto non è cifrato (HTTP): tienilo su rete di casa o VPN.
- Chrome gira con `--no-sandbox` (normale nei container senza privilegi).
