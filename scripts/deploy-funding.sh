#!/usr/bin/env bash
# ==============================================================================
# Robust Deployment Script for VPS
# ==============================================================================
set -euo pipefail

# Auto-detect directory with fallback: hyphen vs underscore
if [ -d "/root/funding-nucleus" ]; then
    APP_DIR="/root/funding-nucleus"
elif [ -d "/root/funding_nucleus" ]; then
    APP_DIR="/root/funding_nucleus"
elif [ -d "${HOME}/funding-nucleus" ]; then
    APP_DIR="${HOME}/funding-nucleus"
elif [ -d "${HOME}/funding_nucleus" ]; then
    APP_DIR="${HOME}/funding_nucleus"
else
    # Fallback to current working directory or first matching folder
    APP_DIR="$(find /root -maxdepth 2 -type d -name "*funding*nucleus*" 2>/dev/null | head -n 1 || pwd)"
fi

SERVICE_NAME="funding-bot"

echo "=========================================================="
echo " Starting Deploy in ${APP_DIR} on $(date -u)"
echo "=========================================================="

cd "${APP_DIR}"

# 1. Pull latest code (if using git)
if [ -d ".git" ]; then
    echo "[1/5] Pulling latest changes from git..."
    git pull origin master || git pull origin main || true
fi

# 2. Install dependencies with peer conflict protection
echo "[2/5] Installing npm dependencies..."
npm install --legacy-peer-deps

# 3. Compile TypeScript
echo "[3/5] Building project (TypeScript)..."
npm run build

# 4. Install / Update systemd service with dynamic path
echo "[4/5] Updating systemd service..."
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Binance-Bybit Funding Arbitrage Trading Bot
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=CONFIG_PATH=./config/config.live.yaml

ExecStart=${NODE_BIN} dist/main.js ./config/config.live.yaml

KillSignal=SIGINT
TimeoutStopSec=30
KillMode=mixed
Restart=always
RestartSec=5s
LimitNOFILE=65536

StandardOutput=journal
StandardError=journal
SyslogIdentifier=funding-bot

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

# 5. Restart service and verify status
echo "[5/5] Restarting ${SERVICE_NAME} service..."
systemctl restart "${SERVICE_NAME}"

sleep 2
systemctl status "${SERVICE_NAME}" --no-pager || true

echo "=========================================================="
echo " Deployment Complete!"
echo " Monitor live logs: journalctl -u ${SERVICE_NAME} -f"
echo "=========================================================="
