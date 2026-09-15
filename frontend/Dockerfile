FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template

# Defaults match the backend Service name/port created by the Helm chart;
# override at deploy time if the backend Service is named/ported differently.
ENV BACKEND_SERVICE_HOST=cloudwatch-insights-backend \
    BACKEND_SERVICE_PORT=8000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ || exit 1
