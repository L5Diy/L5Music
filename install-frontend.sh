#!/usr/bin/env bash
# L5Music — Frontend Installer
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[Frontend]${NC} $1"; }
warn()  { echo -e "${YELLOW}[Frontend]${NC} $1"; }
err()   { echo -e "${RED}[Frontend]${NC} $1"; }

INSTALL_DIR="/opt/l5music"
FRONTEND_SRC="$INSTALL_DIR/frontend"
WEB_DIR="/var/www/l5music"
BACKEND_PORT="3002"

echo ""
echo -e "${BOLD}── L5Music Frontend Setup ──${NC}"
echo ""

# ── Read backend port from .env if it exists ──
if [ -f "$INSTALL_DIR/backend/.env" ]; then
  PORT_LINE=$(grep '^PORT=' "$INSTALL_DIR/backend/.env" 2>/dev/null || true)
  if [ -n "$PORT_LINE" ]; then
    BACKEND_PORT="${PORT_LINE#PORT=}"
  fi
fi

# ── 1. Install nginx ──
if command -v nginx &>/dev/null; then
  info "nginx found"
else
  info "Installing nginx..."
  sudo apt-get update
  sudo apt-get install -y nginx
  info "nginx installed"
fi

# ── 2. Copy frontend files ──
info "Copying frontend files to $WEB_DIR..."
sudo mkdir -p "$WEB_DIR"
sudo cp -r "$FRONTEND_SRC/"* "$WEB_DIR/"
sudo chown -R www-data:www-data "$WEB_DIR"
info "Frontend files copied"

# ── 3. Ask for backend location ──
echo ""
read -rp "Backend port? [$BACKEND_PORT]: " INPUT_PORT
BACKEND_PORT="${INPUT_PORT:-$BACKEND_PORT}"

read -rp "Backend host? [127.0.0.1]: " BACKEND_HOST
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"

# ── 4. Generate nginx config ──
info "Generating nginx config..."
sudo tee /etc/nginx/sites-available/l5music > /dev/null << NGINX
server {
    listen 80;
    server_name _;

    root $WEB_DIR;
    index index.html;

    location = /sw.js {
        alias $WEB_DIR/sw.js;
        add_header Cache-Control "no-store, no-cache, must-revalidate";
        add_header Pragma "no-cache";
    }

    location ~* \\.html\$ {
        add_header Cache-Control "no-cache, must-revalidate";
    }

    location /l5/ws {
        proxy_pass http://$BACKEND_HOST:$BACKEND_PORT/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }

    location /l5/ {
        proxy_pass http://$BACKEND_HOST:$BACKEND_PORT/;
    }

    location /blocked {
        proxy_pass http://$BACKEND_HOST:$BACKEND_PORT/blocked;
    }

    location /shuffle-log {
        proxy_pass http://$BACKEND_HOST:$BACKEND_PORT/shuffle-log;
    }

    location /send-report {
        proxy_pass http://$BACKEND_HOST:$BACKEND_PORT/send-report;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX

# ── 5. Enable site and restart nginx ──
sudo ln -sf /etc/nginx/sites-available/l5music /etc/nginx/sites-enabled/l5music
# Remove default site if it exists (conflicts on port 80)
sudo rm -f /etc/nginx/sites-enabled/default

# Test nginx config
info "Testing nginx config..."
sudo nginx -t

info "Restarting nginx..."
sudo systemctl restart nginx
sudo systemctl enable nginx

# ── 6. Get the Pi's IP for the user ──
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN} Frontend is live!${NC}"
echo -e "${GREEN}${NC}"
echo -e "${GREEN} Open in browser: http://$LOCAL_IP${NC}"
echo -e "${GREEN} Backend proxied: $BACKEND_HOST:$BACKEND_PORT${NC}"
echo -e "${GREEN}${NC}"
echo -e "${GREEN} To set up HTTPS + domain later:${NC}"
echo -e "${GREEN}   ./setup-domain.sh${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
