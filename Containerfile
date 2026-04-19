FROM dhi.io/bun:1.3-debian13

WORKDIR /app
COPY server.ts .
COPY package.json .
COPY root-ca.crt .

ENV PORT=8081
ENV UPSTREAM_URL=http://litellm:4000
ENV UPSTREAM_CA_FILE=/app/root-ca.crt
EXPOSE 8081

CMD ["bun", "run", "server.ts"]
