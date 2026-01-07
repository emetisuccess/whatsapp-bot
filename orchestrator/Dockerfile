FROM node:18-slim
WORKDIR /app
COPY orchestrator.js .
RUN npm install express
EXPOSE 7070
CMD ["node", "orchestrator.js"]
