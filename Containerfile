FROM oven/bun:1

WORKDIR /app
COPY server.ts .
COPY package.json .

# Trust internal root CA
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY root-ca.crt /usr/local/share/ca-certificates/root-ca.crt
RUN update-ca-certificates

ENV PORT=8081
ENV UPSTREAM_URL=http://litellm:4000
EXPOSE 8081

CMD ["bun", "run", "server.ts"]