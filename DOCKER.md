# Docker (server Linux x86-64 a casa)

> **Stato:** l'immagine viene costruita e pubblicata da GitHub Actions su
> `ghcr.io/marcoellecode/hypeddit-support-helper` (solo `linux/amd64`). Codice, rete, token,
> verifica degli account e API sono collaudati su Windows; **il login remoto (Xvfb/noVNC) e Chrome
> nel container sono la parte più nuova**: vedi "Primo avvio: controlli".

## Cosa c'è
Un solo servizio, `hypeddit`:
- cruscotto + API su `:5178` (stessa app di Windows, in headless con Google Chrome);
- **schermo remoto per il login** su `:6080` (Xvfb + x11vnc + noVNC): si accende **solo** quando
  premi "Accedi" su un account e si spegne quando chiudi Chrome;
- volume `hsh-data` (profilo del browser con i login, coda, cronologia, impostazioni) e cartella
  `downloads` sul server.

## Requisiti
- Server **x86-64** con Docker e Docker Compose v2. (Su ARM l'immagine non si costruisce:
  Google Chrome per Linux esiste solo per x86-64.)
- La cartella dei download deve essere scrivibile dall'utente `uid 1000` del container:
  `mkdir -p downloads && sudo chown 1000:1000 downloads`.

## Installazione (immagine da GitHub, consigliata)
```bash
mkdir hypeddit && cd hypeddit
curl -LO https://raw.githubusercontent.com/marcoellecode/hypeddit-support-helper/main/docker-compose.yml
curl -L  https://raw.githubusercontent.com/marcoellecode/hypeddit-support-helper/main/.env.example -o .env
mkdir -p downloads && sudo chown 1000:1000 downloads
nano .env      # HSH_API_TOKEN, HSH_VNC_PASSWORD, HSH_BIND_IP, HSH_ALLOWED_HOSTS
docker compose pull && docker compose up -d
docker compose logs -f
```
Se l'immagine risulta privata (`pull access denied`): su GitHub vai in *Packages →
hypeddit-support-helper → Package settings → Change visibility → Public*.

Per costruirla sul posto invece di scaricarla: clona il repository e usa `docker compose up -d --build`.

## ZimaOS
1. App Store → **Installazione personalizzata** (Custom Install) → importa
   [`docker-compose.zimaos.yml`](docker-compose.zimaos.yml) (puoi incollarne il contenuto).
2. Prima di installare cambia i valori **CAMBIA**: `HSH_API_TOKEN`, `HSH_VNC_PASSWORD` e
   `HSH_ALLOWED_HOSTS` (l'IP di ZimaOS e/o il nome con cui lo raggiungi).
3. Installa. I dati stanno in `/DATA/AppData/hypeddit/data` e i download in
   `/DATA/Downloads/hypeddit` (li vedi dall'app *File*).
4. Apri `http://<IP-ZimaOS>:5178` e prosegui con "Primo accesso agli account".

Il container gira come root (`user: "0:0"`) perché le cartelle `/DATA` di ZimaOS sono di root.

### Rete (LAN / Tailscale)
- `HSH_BIND_IP`: l'IP del server su cui pubblicare le porte. Con Tailscale usa quello `100.x.y.z`
  (`tailscale ip -4`); per la LAN quello di casa. **Non** usare `0.0.0.0` e **non** aprire porte
  sul router.
- `HSH_ALLOWED_HOSTS`: tutti i modi con cui raggiungi il server, separati da virgole, per esempio
  `192.168.1.50,mioserver,mioserver.tailXXXX.ts.net,100.101.102.103`. Con un nome o un IP non
  elencato l'app risponde 403.
- Se metti davanti un reverse proxy (o `tailscale serve`) che cambia la porta, aggiungi
  `HSH_BEHIND_PROXY=1` al `.env`.
- L'app **non parte** senza `HSH_API_TOKEN` quando è raggiungibile dalla rete: pilota i tuoi
  account.

## Primo accesso agli account (una volta sola)
1. Apri `http://<server>:5178` e inserisci il token quando richiesto.
2. **Impostazioni → Account → Accedi** (SoundCloud, Spotify, Instagram, uno alla volta).
3. Si apre una scheda con lo schermo del server (noVNC). Password: `HSH_VNC_PASSWORD`.
4. Accedi come faresti sul PC, **anche con Google** (è Chrome vero, non pilotato). Poi chiudi
   Chrome con la X della finestra: lo schermo si spegne e il collegamento viene verificato.
5. Alla fine **Verifica collegamenti** deve mostrare "Collegato" per tutti.

Il login resta nel volume `hsh-data`: sopravvive a riavvii e aggiornamenti.
Le sessioni sono quelle del server (IP di casa), indipendenti da quelle del tuo PC.

## Uso
Dal cruscotto o dall'API (vedi `API.md`), per esempio:
```bash
curl -X POST http://<server>:5178/api/queue -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"url":"https://hypeddit.com/artista/traccia","start":true}'
```
Per far partire la coda da sola quando arrivano link: Impostazioni → "Avvia la coda da sola…".

### Account scaduti
Se durante la coda un'azione social fallisce, l'app **verifica davvero** l'accesso a quel sito.
Se è scaduto, **ferma la coda**, rimette la traccia in testa, mostra l'avviso nel cruscotto
e in `GET /api/status` (`alert`), e se hai impostato `HSH_WEBHOOK_URL` fa un `POST` JSON
(`event: "account-expired"`, anche `queue-finished`). Rifai il login e riavvia la coda: nessun
link va perso.

## Comandi utili
```bash
docker compose ps                 # stato (c'è anche l'healthcheck)
docker compose logs -f            # log
docker compose restart            # riavvio (la coda riprende dal disco)
docker compose up -d --build      # aggiornamento dopo un cambio al codice
docker compose down               # ferma (i dati restano nei volumi)
```
Backup: il volume `hsh-data` contiene i login. Trattalo come una password.

## Primo avvio: controlli (l'immagine non è stata provata)
```bash
docker compose exec hypeddit sh -c 'ls -l /opt/google/chrome/chrome /usr/share/novnc/vnc.html; which Xvfb x11vnc websockify fluxbox'
curl -s http://<server>:5178/api/health            # {"ok":true,...}
curl -s -H "Authorization: Bearer $TOKEN" http://<server>:5178/api/accounts
```
Se qualcosa non va, cerca nei log le righe `Login remoto: ... non parte` e controlla che
`docker compose exec hypeddit google-chrome-stable --version` (o `/opt/google/chrome/chrome --version`) risponda.

## Limiti e rischi
- **Automatizzare azioni sui tuoi account va contro i termini di Instagram, SoundCloud e
  Spotify** e può far limitare l'account. L'app usa ritmi umani e un tetto di tracce.
- Un browser headless è riconoscibile come tale; non ci sono trucchi per nasconderlo.
- Instagram può chiedere una verifica di sicurezza: se succede l'app ferma la coda come per un
  account scaduto; risolvila dallo schermo remoto (Accedi) e riavvia.
- Il VNC ha una password a 8 caratteri e **non è cifrato**: tienilo solo su LAN o tailnet.
- Chrome gira con `--no-sandbox` (normale nei container senza privilegi).
