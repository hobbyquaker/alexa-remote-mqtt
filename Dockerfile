FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin/ ./bin/
COPY src/ ./src/

ENV NODE_ENV=production \
    ALEXA_REMOTE_MQTT_MQTT_URL=mqtt://localhost \
    ALEXA_REMOTE_MQTT_COOKIE_FILE=/data/cookie.json \
    ALEXA_REMOTE_MQTT_PROXY_OWN_IP=127.0.0.1

RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3001
USER node

ENTRYPOINT ["node", "bin/alexa-remote-mqtt.js"]
