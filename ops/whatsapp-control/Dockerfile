FROM node:22-alpine
WORKDIR /app
COPY controller.js /app/controller.js
COPY bootstrap-control.json /app/bootstrap-control.json
RUN mkdir -p /data
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8788/health >/dev/null || exit 1
CMD ["sh", "-lc", "test -f /data/control.json || cp /app/bootstrap-control.json /data/control.json; exec node /app/controller.js"]
