FROM ghcr.io/puppeteer/puppeteer:24.40.0

ENV NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /home/pptruser/app

RUN mkdir -p /sessions \
    && chown -R pptruser:pptruser /sessions

COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --omit=dev

COPY --chown=pptruser:pptruser . .

EXPOSE 9000 9090

CMD ["node", "index.js"]
