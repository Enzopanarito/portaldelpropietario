FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /data/profile /data/screenshots

ENV NODE_ENV=production \
    PORT=8787 \
    TZ=America/Caracas \
    WA_MODE=simulation \
    VLA_PUBLIC_URL=https://villalosapamates.netlify.app/api/vla/public-data?force=1

EXPOSE 8787
CMD ["sh", "-lc", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99; Xvfb :99 -screen 0 1440x960x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & export DISPLAY=:99; exec node server.js"]
