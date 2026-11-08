#!/bin/bash
source /contract/env.vars
# Generate SSH keys if missing
[ ! -f /etc/ssh/ssh_host_rsa_key ] && ssh-keygen -A

chown -R everweb:everweb /home/everweb

# First-run setup (TJ / Electro⚡Nickels): if no admin password is set, make a
# one-time setup code and print it here, so it shows in the panel's Docker Logs.
runuser -u everweb -- /usr/bin/node /home/everweb/first-run-setup.js || echo "[setup] Setup step failed. Admin stays locked (never opened). Use Docker restart in your panel to try again."

CFG_FILE="/contract/cfg/hp.cfg"
HTML_FILE="/home/everweb/index.js"

userport=$(awk '
  $0 ~ /"user"/ { user_block=1 }
  user_block && $0 ~ /"port"/ {
    gsub(/[ ,]/, "", $2);
    gsub(/[^0-9]/, "", $2);
    print $2;
    exit
  }
' "$CFG_FILE")

if [[ -z "$userport" ]]; then
  echo "Could not extract user.port from $CFG_FILE"
  exit 1
fi

sed -i -E "s|(wss://localhost:)[0-9]+|\1$userport|g" "$HTML_FILE"
echo "Replaced port with $userport in $HTML_FILE"

SSHD_CONFIG="/etc/ssh/sshd_config"
PORT_LINE="Port $EXTERNAL_GPTCP2_PORT"

if [[ -n "${EXTERNAL_GPTCP2_PORT// }" ]]; then
  if ! grep -q "^$PORT_LINE\$" "$SSHD_CONFIG"; then
    echo "$PORT_LINE" >> "$SSHD_CONFIG"
  else
    echo "Port line already present, skipping append."
  fi
fi

# Patch config values
sed -i \
  -e "s|\"bin_path\": \".*\"|\"bin_path\": \"/usr/bin/node\"|" \
  -e "s|\"bin_args\": \".*\"|\"bin_args\": \"index.js\"|" \
  "$CFG_FILE"

sed -i '/"peer_discovery"/,/}/s/"enabled": true/"enabled": false/' "$CFG_FILE"

chown everweb:everweb "$CFG_FILE"
chown -R everweb:everweb /contract/cfg/

# Clean up state folder
if [ -d "/home/everweb/contract" ]; then
  cp -r /home/everweb/contract/* /contract/contract_fs/seed/state/
fi
rm -f /contract/contract_fs/seed/state/bootstrap_*
rm -f /contract/contract_fs/seed/state/install.sh
rm -f /contract/contract_fs/seed/state/hp.cfg.override
if [ -d "/home/everweb/contract" ]; then
rm -rf /home/everweb/contract/
fi

sed -i 's/"log_level": "err"/"log_level": "inf"/' /contract/cfg/hp.cfg
#/usr/bin/node /home/everweb/index.js &

# Start supervisord
exec /usr/bin/supervisord -c /home/everweb/supervisord.conf