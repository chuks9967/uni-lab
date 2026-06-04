# Container image for the UniBursar cloud hub (Fly.io, Koyeb, Railway, any Docker host).
# Zero npm dependencies, so there is nothing to install — it just runs.
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
# Hosts set $PORT; the server reads it. DATA_DIR can point at a mounted volume.
EXPOSE 8080
CMD ["node", "server.js"]
