#!/usr/bin/env bash
# ==============================================================================
# Binance-Bybit Funding Arbitrage Bot — Ubuntu/Debian VM Automated Setup
# ==============================================================================
set -euo pipefail

echo "=========================================================="
echo " Starting Funding Arbitrage Bot Linux VM Setup"
echo "=========================================================="

APP_USER="${USER:-ubuntu}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[*] Detected App Directory: ${APP_DIR}"
echo "[*] Detected User:          ${APP_USER}"

# 1. Update OS packages & install prerequisites
echo "[1/6] Installing build dependencies..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential sqlite3 ca-certificates gnupg

# 2. Install Node.js 20 LTS (or verify existing)
if ! command -v node &> /dev/null; then
    echo "[2/6] Node.js not detected. Installing Node.js LTS (v20.x)..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "[2/6] Node.js already installed: $(node -v)"
fi

# 3. Create required runtime directories & verify .env
echo "[3/6] Setting up project workspace..."
mkdir -p "${APP_DIR}/data"
cd "${APP_DIR}"

if [ ! -f "${APP_DIR}/.env" ]; then
    if [ -f "${APP_DIR}/.env.example" ]; then
        echo "[!] No .env found. Copying .env.example to .env..."
        cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
        echo "[!] WARNING: Please edit ${APP_DIR}/.env with your real API credentials!"
    else
        echo "[!] ERROR: No .env found. Please create ${APP_DIR}/.env"
        exit 1
    fi
fi

# 4. Install npm dependencies & compile TypeScript
echo "[4/6] Installing NPM packages & building project..."
npm ci --omit=dev || npm install
npm run build

# 5. Configure systemd service
echo "[5/6] Configuring systemd service..."
SERVICE_FILE="/etc/systemd/system/funding-bot.service"
NODE_BIN="$(command -v node)"

sudo bash -c "cat > ${SERVICE_FILE}" <<EOF
[Unit]
Description=Binance-Bybit Funding Arbitrage Trading Bot
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=CONFIG_PATH=./config/config.live.yaml

ExecStart=${NODE_BIN} dist/main.js ./config/config.live.yaml

# Graceful shutdown (30s timeout allows active operations to resolve safely)
KillSignal=SIGINT
TimeoutStopSec=30
KillMode=mixed

# Auto-recovery
Restart=always
RestartSec=5s

# Hardening
NoNewPrivileges=true
LimitNOFILE=65536

StandardOutput=journal
StandardError=journal
SyslogIdentifier=funding-bot

[Install]
WantedBy=multi-user.target
EOF

# 6. Enable and reload systemd daemon
echo "[6/6] Reloading systemd daemon..."
sudo systemctl daemon-reload
sudo systemctl enable funding-bot.service

echo ""
echo "=========================================================="
echo " Setup Completed Successfully!"
echo "=========================================================="
echo "Next Steps:"
echo " 1. Verify your credentials:  nano ${APP_DIR}/.env"
echo " 2. Validate connection:      npm run validate-credentials"
echo " 3. Start the service:        sudo systemctl start funding-bot"
echo " 4. View live logs:           sudo journalctl -u funding-bot -f"
echo " 5. Check service status:     sudo systemctl status funding-bot"
echo " 6. Check bot trading PnL:    npm run status"
echo "=========================================================="

