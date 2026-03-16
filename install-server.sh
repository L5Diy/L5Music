#!/usr/bin/env bash
# L5Music — Backend Installer
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[Backend]${NC} $1"; }
warn()  { echo -e "${YELLOW}[Backend]${NC} $1"; }
err()   { echo -e "${RED}[Backend]${NC} $1"; }

INSTALL_DIR="/opt/l5music"
BACKEND_DIR="$INSTALL_DIR/backend"

echo ""
echo -e "${BOLD}── L5Music Backend Setup ──${NC}"
echo ""

# ── 1. Check/install Node.js ──
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  info "Node.js found: $NODE_VER"
else
  info "Node.js not found. Installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  info "Node.js installed: $(node -v)"
fi

# ── 2. Check/install yt-dlp ──
if command -v yt-dlp &>/dev/null; then
  info "yt-dlp found: $(yt-dlp --version)"
else
  info "Installing yt-dlp..."
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  info "yt-dlp installed"
fi

# ── 3. Check/install ffmpeg (needed by yt-dlp) ──
if command -v ffmpeg &>/dev/null; then
  info "ffmpeg found"
else
  info "Installing ffmpeg..."
  sudo apt-get install -y ffmpeg
  info "ffmpeg installed"
fi

# ── 4. Ask for music folder ──
echo ""
DEFAULT_MUSIC="$HOME/music"
read -rp "Where is your music folder? [$DEFAULT_MUSIC]: " MUSIC_DIR
MUSIC_DIR="${MUSIC_DIR:-$DEFAULT_MUSIC}"

# Create it if it doesn't exist
if [ ! -d "$MUSIC_DIR" ]; then
  info "Creating music folder: $MUSIC_DIR"
  mkdir -p "$MUSIC_DIR"
fi

# ── 5. Ask for port ──
read -rp "Backend port? [3002]: " PORT
PORT="${PORT:-3002}"

# ── 6. Optional: Gmail for signup emails ──
echo ""
echo "Optional: Gmail for signup invite emails."
echo "  (Requires a Google App Password, not your regular password)"
echo "  Press Enter to skip."
read -rp "Gmail address: " GMAIL_USER
GMAIL_PASS=""
if [ -n "$GMAIL_USER" ]; then
  read -rsp "Gmail app password: " GMAIL_PASS
  echo ""
fi

# ── 7. Write .env ──
info "Writing .env..."
cat > "$BACKEND_DIR/.env" << EOF
PORT=$PORT
MUSIC_DIR=$MUSIC_DIR
DOMAIN=localhost
GMAIL_USER=$GMAIL_USER
GMAIL_PASS=$GMAIL_PASS
EOF
info ".env created at $BACKEND_DIR/.env"

# ── 8. Install npm dependencies ──
info "Installing dependencies..."
cd "$BACKEND_DIR"
npm install

# ── 9. Create data directory ──
mkdir -p "$BACKEND_DIR/data"

# ── 10. Set up PM2 ──
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2..."
  sudo npm install -g pm2
fi

# Stop existing instance if running
pm2 delete l5music-core 2>/dev/null || true

info "Starting l5music-core with PM2..."
cd "$BACKEND_DIR"
pm2 start server.js --name l5music-core
pm2 save

# Set up PM2 to start on boot
info "Setting up auto-start on reboot..."
pm2 startup 2>/dev/null | grep "sudo" | bash 2>/dev/null || true
pm2 save

echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN} Backend is running on port $PORT${NC}"
echo -e "${GREEN} Music folder: $MUSIC_DIR${NC}"
echo -e "${GREEN} PM2 process: l5music-core${NC}"
echo -e "${GREEN}${NC}"
echo -e "${GREEN} Check logs:  pm2 logs l5music-core${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
