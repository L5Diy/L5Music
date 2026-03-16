#!/usr/bin/env bash
# L5Music — All-in-one installer
# Usage: curl -sL https://raw.githubusercontent.com/L5Diy/L5Music/main/install.sh | bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[L5Music]${NC} $1"; }
warn()  { echo -e "${YELLOW}[L5Music]${NC} $1"; }
err()   { echo -e "${RED}[L5Music]${NC} $1"; }

echo ""
echo -e "${BOLD}╔═══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║         L5Music Installer v1.0        ║${NC}"
echo -e "${BOLD}║   Self-hosted music streaming PWA     ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════╝${NC}"
echo ""

# ── Check we're on Linux ──
if [[ "$(uname)" != "Linux" ]]; then
  err "L5Music requires Linux (Raspberry Pi, Ubuntu, Debian, etc.)"
  exit 1
fi

# ── Menu ──
echo "What would you like to install?"
echo ""
echo "  1) Backend + Frontend  (full install)"
echo "  2) Backend only        (API server)"
echo "  3) Frontend only       (web UI + nginx)"
echo "  4) Set up HTTPS/domain (after install)"
echo "  5) Exit"
echo ""
read -rp "Choose [1-5]: " choice

REPO_URL="https://github.com/L5Diy/L5Music.git"
INSTALL_DIR="/opt/l5music"

case "$choice" in
  1)
    info "Full install selected — backend + frontend"
    echo ""
    # Clone repo if not already present
    if [ ! -d "$INSTALL_DIR" ]; then
      info "Cloning L5Music..."
      sudo mkdir -p "$INSTALL_DIR"
      sudo chown "$(whoami)":"$(whoami)" "$INSTALL_DIR"
      git clone "$REPO_URL" "$INSTALL_DIR"
    else
      warn "$INSTALL_DIR already exists, pulling latest..."
      cd "$INSTALL_DIR" && git pull
    fi

    # Run both installers
    chmod +x "$INSTALL_DIR/install-server.sh"
    chmod +x "$INSTALL_DIR/install-frontend.sh"
    bash "$INSTALL_DIR/install-server.sh"
    bash "$INSTALL_DIR/install-frontend.sh"
    ;;
  2)
    info "Backend only selected"
    echo ""
    if [ ! -d "$INSTALL_DIR" ]; then
      info "Cloning L5Music..."
      sudo mkdir -p "$INSTALL_DIR"
      sudo chown "$(whoami)":"$(whoami)" "$INSTALL_DIR"
      git clone "$REPO_URL" "$INSTALL_DIR"
    else
      warn "$INSTALL_DIR already exists, pulling latest..."
      cd "$INSTALL_DIR" && git pull
    fi
    chmod +x "$INSTALL_DIR/install-server.sh"
    bash "$INSTALL_DIR/install-server.sh"
    ;;
  3)
    info "Frontend only selected"
    echo ""
    if [ ! -d "$INSTALL_DIR" ]; then
      info "Cloning L5Music..."
      sudo mkdir -p "$INSTALL_DIR"
      sudo chown "$(whoami)":"$(whoami)" "$INSTALL_DIR"
      git clone "$REPO_URL" "$INSTALL_DIR"
    else
      warn "$INSTALL_DIR already exists, pulling latest..."
      cd "$INSTALL_DIR" && git pull
    fi
    chmod +x "$INSTALL_DIR/install-frontend.sh"
    bash "$INSTALL_DIR/install-frontend.sh"
    ;;
  4)
    info "Domain/HTTPS setup selected"
    if [ ! -d "$INSTALL_DIR" ]; then
      err "L5Music not found at $INSTALL_DIR. Run a full install first."
      exit 1
    fi
    chmod +x "$INSTALL_DIR/setup-domain.sh"
    bash "$INSTALL_DIR/setup-domain.sh"
    ;;
  5)
    info "Bye!"
    exit 0
    ;;
  *)
    err "Invalid choice. Run the installer again."
    exit 1
    ;;
esac
