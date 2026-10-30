#!/usr/bin/env bash
# ==============================================================================
# Deployment Script for /root/funding-nucleus on VPS
# ==============================================================================
set -euo pipefail

APP_DIR="/root/funding-nucleus"
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

# 4. Install / Update systemd service
echo "[4/5] Updating systemd service..."
if [ -f "${APP_DIR}/scripts/funding-bot.service" ]; then
    cp "${APP_DIR}/scripts/funding-bot.service" "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    systemctl enable "${SERVICE_NAME}"
fi

# 5. Restart service and verify status
echo "[5/5] Restarting ${SERVICE_NAME} service..."
systemctl restart "${SERVICE_NAME}"

sleep 2
systemctl status "${SERVICE_NAME}" --no-pager || true

echo "=========================================================="
echo " Deployment Complete!"
echo " Monitor live logs: journalctl -u ${SERVICE_NAME} -f"
echo "=========================================================="

