# The target application only. The automation runs on the host, driving a
# browser at this container — keeping the two apart is what makes the surface
# feel like a third-party system rather than something we can reach into.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.mjs"]
