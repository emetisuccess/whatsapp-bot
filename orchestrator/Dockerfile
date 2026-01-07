FROM node:18-slim

# install curl
RUN apt-get update && apt-get install -y curl ca-certificates gnupg

# install official docker cli
RUN curl -fsSL https://get.docker.com | sh

WORKDIR /app
COPY orchestrator.js .

RUN npm install express

EXPOSE 7070
CMD ["node", "orchestrator.js"]
