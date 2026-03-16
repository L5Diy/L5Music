#!/usr/bin/env bash
# L5Music — Domain + HTTPS Setup
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[Domain]${NC} $1"; }
warn()  { echo -e "${YELLOW}[Domain]${NC} $1"; }
err()   { echo -e "${RED}[Domain]${NC} $1"; }

INSTALL_DIR="/opt/l5music"
WEB_DIR="/var/www/l5music"

echo ""
echo -e "${BOLD}── L5Music Domain + HTTPS Setup ──${NC}"
echo ""
echo "Before running this, make sure you have:"
echo "  1. A domain name pointing to this machine's public IP"
echo "  2. Port 80 and 443 forwarded on your router"
echo ""

# ── 1. Ask for domain ──
read -rp "Your domain name (e.g. music.example.com): " DOMAIN
if [ -z "$DOMAIN" ]; then
  err "Domain is required. Exiting."
  exit 1
fi

read -rp "Email for Let's Encrypt certificate: " EMAIL
if [ -z "$EMAIL" ]; then
  err "Email is required for SSL certificate. Exiting."
  exit 1
fi

# ── 2. Install certbot ──
if command -v certbot &>/dev/null; then
  info "certbot found"
else
  info "Installing certbot..."
  sudo apt-get update
  sudo apt-get install -y certbot python3-certbot-nginx
  info "certbot installed"
fi

# ── 3. Update nginx server_name ──
info "Updating nginx config with domain: $DOMAIN"
sudo sed -i "s/server_name _;/server_name $DOMAIN;/" /etc/nginx/sites-available/l5music
sudo nginx -t
sudo systemctl reload nginx

# ── 4. Get SSL certificate ──
info "Requesting SSL certificate from Let's Encrypt..."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"

# ── 5. Update backend .env with domain ──
if [ -f "$INSTALL_DIR/backend/.env" ]; then
  if grep -q '^DOMAIN=' "$INSTALL_DIR/backend/.env"; then
    sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" "$INSTALL_DIR/backend/.env"
  else
    echo "DOMAIN=$DOMAIN" >> "$INSTALL_DIR/backend/.env"
  fi
  info "Updated backend .env with DOMAIN=$DOMAIN"

  # Restart backend to pick up new domain
  if command -v pm2 &>/dev/null; then
    pm2 restart l5music-core
    info "Backend restarted"
  fi
fi

# ── 6. Set up auto-renewal ──
info "Testing certificate auto-renewal..."
sudo certbot renew --dry-run

echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN} HTTPS is live!${NC}"
echo -e "${GREEN}${NC}"
echo -e "${GREEN} Your site: https://$DOMAIN${NC}"
echo -e "${GREEN} SSL auto-renews via certbot${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
