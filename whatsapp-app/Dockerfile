FROM node:18-bullseye

# Install required dependencies for Chromium
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxrandr2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxdamage1 \
    wget; \
    if ! apt-get install -y --no-install-recommends libasound2; then \
    apt-get install -y --no-install-recommends libasound2t64; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# IMPORTANT: allow puppeteer to download its own chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

RUN npm install --production

COPY . .

EXPOSE 9000 9090

CMD ["node", "index.js"]
