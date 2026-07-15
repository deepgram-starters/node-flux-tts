# Backend-only image for the Flux TTS starter.
#
# Once the frontend submodule (flux-tts-html) exists, replace this with the
# Caddy + frontend multi-stage build from the node-flux starter so static assets
# and rate limiting are served at the edge (internal_port 8080).
FROM node:24-slim
RUN corepack enable

WORKDIR /app

# Install backend production dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod

# Copy backend source and config
COPY *.js *.toml sample.env ./

ENV PORT=8081
ENV HOST=0.0.0.0
EXPOSE 8081

CMD ["node", "--no-deprecation", "server.js"]
