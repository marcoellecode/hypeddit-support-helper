# Hypeddit Support Helper in Docker (solo x86-64: Google Chrome per Linux non esiste per ARM).
# Un unico servizio: cruscotto + API + browser headless. Il login degli account si fa una
# tantum con Chrome "normale" dentro uno schermo remoto (noVNC), vedi DOCKER.md.
FROM node:22-bookworm-slim

# Chrome stabile esiste solo per amd64: meglio fallire subito e chiaramente
RUN [ "$(dpkg --print-architecture)" = "amd64" ] || \
    (echo "ERRORE: questa immagine richiede una macchina x86-64 (amd64)." && exit 1)

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Europe/Rome \
    HOME=/tmp \
    HSH_DOCKER=1 \
    HSH_HOST=0.0.0.0 \
    HSH_PORT=5178 \
    HSH_DATA_DIR=/data \
    HSH_PROFILE_DIR=/data/profile \
    HSH_DOWNLOAD_DIR=/downloads \
    HSH_REMOTE_LOGIN=1 \
    NO_OPEN=1

# tini (gestione segnali: `docker stop` arriva al server), schermo virtuale + VNC + noVNC per
# il login, font (le pagine web li richiedono)
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini curl ca-certificates tzdata fonts-liberation \
      xvfb x11vnc fluxbox novnc websockify \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Google Chrome stabile con le sue dipendenze di sistema (via Playwright)
RUN npx playwright install --with-deps chrome && rm -rf /var/lib/apt/lists/*

COPY . .

# /tmp/.X11-unix: serve a Xvfb quando gira senza root
RUN mkdir -p /data /downloads /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    && chown -R node:node /data /downloads /app
USER node

VOLUME ["/data", "/downloads"]
EXPOSE 5178 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fs "http://127.0.0.1:${HSH_PORT}/api/health" || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
