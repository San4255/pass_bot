#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# Termux setup - naye device par ek command se sab install:
#   bash setup.sh
# ============================================================
set -e
cd "$(dirname "$0")"

# ---- Versions (apne purane device ke versions yahan daalo) ----
BAILEYS_VERSION="7.0.0-rc14"
QRCODE_TERMINAL_VERSION="0.12.0"
PINO_VERSION="10.3.1"
NODE_EXPECTED_MAJOR="26"   # purane device par v26.4.0 tha
# ----------------------------------------------------------------

echo "📦 Termux packages install ho rahe hain..."
pkg update -y
pkg upgrade -y -o Dpkg::Options::="--force-confold"
pkg install -y nodejs git

echo "🟢 Node: $(node -v) | npm: $(npm -v)"
if [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_EXPECTED_MAJOR" ]; then
    echo "⚠️ Node major version $NODE_EXPECTED_MAJOR expected tha, alag hai - bot me issue aaye to yeh dhyan rakhna"
fi

if [ -f package-lock.json ]; then
    # Lock file ho to bilkul wahi versions (sub-dependencies samet) install honge
    echo "🔒 package-lock.json mili - exact versions install ho rahe hain..."
    npm ci
else
    if [[ "$BAILEYS_VERSION" == "__FILL__" || "$QRCODE_TERMINAL_VERSION" == "__FILL__" || "$PINO_VERSION" == "__FILL__" ]]; then
        echo "❌ setup.sh ke upar wale versions bhare nahi hain (ya package-lock.json repo mein nahi hai)."
        exit 1
    fi
    [ -f package.json ] || npm init -y >/dev/null
    echo "⬇️ Pinned versions install ho rahe hain..."
    npm install --save-exact \
        "@whiskeysockets/baileys@$BAILEYS_VERSION" \
        "qrcode-terminal@$QRCODE_TERMINAL_VERSION" \
        "pino@$PINO_VERSION"
fi

echo ""
echo "✅ Setup complete!"
echo "Ab chalao:  node bot.js   (pehli baar QR scan karna hoga)"
