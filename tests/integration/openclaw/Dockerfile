FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bash \
     ca-certificates \
     python3 \
     make \
     g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.2.6

ENV HOME=/opt/openclaw
WORKDIR /opt/openclaw

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 19003

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
