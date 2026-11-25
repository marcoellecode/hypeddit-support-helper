# API (REST/JSON)

> Questa documentazione è anche **nell'interfaccia**, scheda **API**: con esempi pronti da copiare
> (PowerShell o curl) e un pulsante «Esegui» per provare ogni chiamata dal vivo.

Base: `http://127.0.0.1:5178`. L'elenco aggiornato degli endpoint è anche su `GET /api`.

## Concetti
- **Coda persistente** (`data/queue.json`): sopravvive ai riavvii. Puoi aggiungere link in
  qualsiasi momento, anche mentre la coda sta lavorando: il worker li prende da solo.
- **Avvio:** un link aggiunto non parte da solo, salvo che:
  - mandi `"start": true` nella richiesta, oppure
  - sia attiva l'impostazione **"Avvia la coda da sola quando arriva un link via API"**
    (`autoStart`, in Impostazioni).
- **Tetto** `maxTracksPerRun`: oltre il tetto i link restano in coda; si riparte con un nuovo avvio.
- Le tracce già scaricate vengono rifiutate (`alreadyDownloaded`) salvo `"skipDone": false`.
- **Sicurezza:** il token è **facoltativo**. Senza `HSH_API_TOKEN` l'API non chiede nulla (su PC ascolta
  solo su `127.0.0.1`; in Docker è raggiungibile dalla rete). Se lo imposti, ogni `/api/*` (tranne
  `/api/health`) richiede `Authorization: Bearer <token>` oppure `X-API-Key: <token>`; l'interfaccia lo chiede
  una volta e lo ricorda.

## Coda
| Metodo | Percorso | Cosa fa |
|---|---|---|
| `POST` | `/api/queue` | Aggiunge link. Body JSON `{"urls":[...]}` o `{"url":"..."}` (+ `start`, `skipDone`, `source`), oppure testo semplice (uno per riga). |
| `GET` | `/api/queue` | Coda in attesa, traccia in lavorazione, esito dell'esecuzione corrente. |
| `DELETE` | `/api/queue` | Svuota la coda. Con `?url=<url codificato>` toglie un solo link. Non tocca la traccia in lavorazione. |
| `POST` | `/api/queue/start` | Avvia la coda (body opzionale con `urls`, come `POST /api/queue`). `409` se già in corso. |
| `POST` | `/api/queue/stop` | Si ferma alla fine dello step corrente; la traccia interrotta resta in testa alla coda. |
| `POST` | `/api/queue/retry` | Rimette in coda le non scaricate. Body opzionale `{"statuses":["needs-manual",...],"start":true}`. |

Risposta di `POST /api/queue` (`201` se almeno un link è stato aggiunto, altrimenti `200`;
`400` se nessun URL è valido):
```json
{ "ok": true,
  "added": ["https://hypeddit.com/a/tre"],
  "duplicates": [], "alreadyDownloaded": [], "invalid": [],
  "started": false, "running": false, "pending": 3 }
```

## Stato, cronologia, log
| Metodo | Percorso | Cosa fa |
|---|---|---|
| `GET` | `/api/health` | `{ok, running, pending}` — non richiede token. |
| `GET` | `/api/status` | Stato completo (quello usato dall'interfaccia). |
| `GET` | `/api/history` | Esito per traccia. Filtro `?status=downloaded,needs-manual,no-download,error,stopped`. |
| `GET` | `/api/log` | Ultime righe di log (`?lines=100`, max 500). |
| `GET` | `/api/accounts` | Account collegati (SoundCloud/Spotify/Instagram) ed email impostata. |
| `POST` | `/api/accounts/check` | Riverifica i collegamenti, in modo reale (non mentre la coda gira). |
| `POST` | `/api/accounts/:site/login` | Apre il login (`soundcloud`, `spotify`, `instagram`). Se è già aperto lo **riapre**. In Docker risponde con `remote.path`: l'indirizzo dello schermo remoto, sulla stessa porta dell'app. |
| `POST` | `/api/login/close` | Chiude il login (anche se la finestra è «rimasta aperta») e riverifica gli account. |

## Impostazioni e file
| Metodo | Percorso | Cosa fa |
|---|---|---|
| `GET` / `POST` | `/api/settings` | Legge / modifica (anche solo alcuni campi): `name`, `email`, `comment`, `autoStart`, `maxTracksPerRun`, `betweenTracksMs`, … |
| `GET` | `/api/downloads` | Elenco dei file scaricati. |
| `GET` | `/api/downloads/:name` | Scarica un file. |

## Esempi (PowerShell / curl)
```powershell
# aggiungi un link e avvia
curl.exe -X POST http://127.0.0.1:5178/api/queue -H "Content-Type: application/json" `
  -d '{\"url\":\"https://hypeddit.com/artista/traccia\",\"start\":true}'

# aggiungi molti link in testo semplice
curl.exe -X POST http://127.0.0.1:5178/api/queue -H "Content-Type: text/plain" --data-binary "@link.txt"

# stato rapido, log, cronologia delle tracce da fare a mano
curl.exe http://127.0.0.1:5178/api/queue
curl.exe "http://127.0.0.1:5178/api/log?lines=30"
curl.exe "http://127.0.0.1:5178/api/history?status=needs-manual"
```
Con token: aggiungi `-H "Authorization: Bearer <token>"`.

Stati nella cronologia: `downloaded`, `needs-manual` (con `reason`), `no-download`, `error`, `stopped`.
