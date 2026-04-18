FROM node:18-slim

# Install curl + CA certs
RUN apt-get update && apt-get install -y curl ca-certificates gnupg

# Install Docker CLI (orchestrator needs docker command, uses host docker.sock)
RUN curl -fsSL https://get.docker.com | sh

WORKDIR /app
COPY orchestrator.js .
COPY registry.js .

# Install deps
RUN npm init -y
RUN npm install express axios ioredis
RUN npm cache clean --force

EXPOSE 7070
CMD ["node", "orchestrator.js"]
