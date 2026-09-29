FROM node:22-slim
WORKDIR /app

# Install dependencies (tsx is a devDependency, needed to run the server)
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm install --no-audit --no-fund

# Copy app code (server + static client)
COPY server/ ./server/
COPY client/ ./client/

# Don't bake in local dev secrets or database
RUN rm -f server/.env && rm -rf server/data

WORKDIR /app/server
ENV PORT=10000
EXPOSE 10000

# On first boot: seed the DB + generate secrets, then start.
# PUBLIC_BASE_URL falls back to the host's public URL (e.g. Render's).
CMD ["sh", "-c", "export PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-$RENDER_EXTERNAL_URL}; if [ ! -f .env ]; then npm run seed; fi && npm start"]
