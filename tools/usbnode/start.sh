#!/bin/sh
# TOMLIN node (Bootable USB): run by tomlin-node.service at every start. Unpacks what the stick carries (Node.js, the
# llama.cpp builds, TOMLIN itself) into /opt/tomlin when the stick has something new, gets a wired network, opens the
# node's ports to the home network only, installs the few packages the hardware reading and the Vulkan runner need
# (once, with a network), installs NVIDIA's driver when the "install NVIDIA driver" entry was picked, sets the clock,
# then starts TOMLIN as a node. Everything it does is logged to /var/log/tomlin-node-setup.log.
#   start.sh setup   as root (the service's ExecStartPre=+): all of the above but TOMLIN itself
#   start.sh run     as the plain user tomlin-node (the service's ExecStart): TOMLIN
# (The node here is TOMLIN itself, an ordinary linked PC.)
set -u
#   start.sh unpack  only the unpacking, into TOMLIN_OPT from TOMLIN_MEDIUM (a check of a minted stick, on any PC)
MEDIUM=${TOMLIN_MEDIUM:-/run/live/medium/tomlin}
OPT=${TOMLIN_OPT:-/opt/tomlin}
APP=$OPT/app
STATE=${TOMLIN_STATE:-/var/lib/tomlin-node}
LOG=/var/log/tomlin-node-setup.log
NODE_USER=tomlin-node
MODE=${1:-}
# The ports TOMLIN uses on a node: the link (8741), a cluster's RPC servers (50052 up) and Max mode's lending door.
LINK_PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$MEDIUM/tomlin-node.json" 2>/dev/null | head -n1)
LINK_PORT=${LINK_PORT:-8741}

# "run": the service's main step, as the plain user (the service ran "setup" as root just before).
if [ "$MODE" = run ]; then
  [ -x "$OPT/node/bin/node" ] || { echo "Node.js is not unpacked: see $LOG"; exit 1; }
  mkdir -p "$TOMLIN_HOME"
  cd "$APP" || exit 1
  # The models the stick carries are offered as a models folder (read where they are, never copied).
  export TOMLIN_SCREEN=/dev/tty1
  exec "$OPT/node/bin/node" src/server.ts
fi
if [ "$MODE" = unpack ]; then LOG=${TOMLIN_LOG:-$OPT/setup.log}
elif [ "$(id -u)" != 0 ]; then echo "start.sh setup needs root."; exit 1; fi
mkdir -p "$OPT"
[ "$MODE" = unpack ] || mkdir -p "$STATE"

say() { echo "$*"; echo "$(date -Is) $*" >> "$LOG"; [ "$MODE" != unpack ] && [ -w /dev/tty1 ] && echo "$*" > /dev/tty1; return 0; }
[ -w /dev/tty1 ] && printf '\033[2J\033[H' > /dev/tty1
say "TOMLIN node: starting"

# ---- Unpack: each archive once (a marker per file name, so a stick minted again with new files is unpacked again) ----
unpack() { # $1 archive, $2 folder, $3 tar options
  name=$(basename "$1")
  [ -f "$2/.from-$name" ] && return 0
  say "Unpacking $name"
  rm -rf "$2"; mkdir -p "$2"
  if tar $3 "$1" -C "$2" >> "$LOG" 2>&1; then touch "$2/.from-$name"; else say "  could not unpack $name"; fi
}
# A llama.cpp build into TOMLIN's runtime/<id>: the folder holding llama-server is laid flat there, so TOMLIN finds it
# as it finds the Windows builds (src/runtimes.ts looks in the folder and one folder inside it).
runner() { # $1 archive, $2 runtime id
  dest="$APP/runtime/$2"
  name=$(basename "$1")
  [ -f "$OPT/runners/.from-$2-$name" ] && [ -x "$dest/llama-server" ] && return 0
  say "Unpacking $name"
  tmp="$OPT/runners/tmp-$2"
  rm -rf "$tmp" "$dest"; mkdir -p "$tmp" "$dest"
  if tar -xzf "$1" -C "$tmp" >> "$LOG" 2>&1; then
    bin=$(dirname "$(find "$tmp" -name llama-server -type f | head -n1)")
    if [ -n "$bin" ] && [ "$bin" != "." ]; then
      cp -a "$bin"/. "$dest"/ && touch "$OPT/runners/.from-$2-$name"
    else say "  $name has no llama-server in it"; fi
  else say "  could not unpack $name"; fi
  rm -rf "$tmp"
}

# TOMLIN itself, fresh from the stick each start (a stick minted again brings the new version).
if [ ! -f "$OPT/.app-stamp" ] || ! cmp -s "$MEDIUM/tomlin-node.json" "$OPT/.app-stamp"; then
  say "Copying TOMLIN from the stick"
  rm -rf "$APP"; cp -r "$MEDIUM/app" "$APP" && cp -f "$MEDIUM/tomlin-node.json" "$OPT/.app-stamp"
fi
cp -f "$MEDIUM/tomlin-node.json" "$OPT/tomlin-node.json"
mkdir -p "$OPT/runners"
for f in "$MEDIUM"/downloads/node-v*-linux-x64.tar.xz; do [ -f "$f" ] && unpack "$f" "$OPT/node" "--strip-components=1 -xJf"; done
for f in "$MEDIUM"/downloads/llama-*-bin-ubuntu-x64.tar.gz; do [ -f "$f" ] && runner "$f" llama-cpu; done
for f in "$MEDIUM"/downloads/llama-*-bin-ubuntu-vulkan-x64.tar.gz; do [ -f "$f" ] && runner "$f" llama-vulkan; done
for f in "$MEDIUM"/downloads/llama-*-bin-ubuntu-cuda-*-x64.tar.gz; do
  [ -f "$f" ] || continue
  runner "$f" llama-cuda
  for r in "$MEDIUM"/downloads/cudart-llama-*-ubuntu-cuda-*-x64.tar.gz; do
    [ -f "$r" ] || continue
    # The CUDA runtime goes next to the programs (they find their libraries in their own folder).
    [ -f "$APP/runtime/llama-cuda/.from-$(basename "$r")" ] || { tar -xzf "$r" -C "$APP/runtime/llama-cuda" --strip-components=1 >> "$LOG" 2>&1 && touch "$APP/runtime/llama-cuda/.from-$(basename "$r")"; }
  done
done
find "$APP/runtime" -type f \( -name 'llama-*' -o -name '*rpc-server' \) -exec chmod 0755 {} + 2>/dev/null
[ "$MODE" = unpack ] && { say "Unpacked into $OPT"; exit 0; }
if [ ! -x "$OPT/node/bin/node" ]; then say "Node.js is not on this stick: on the admin PC, Settings, Bootable USB, press Mint again."; sleep 600; exit 1; fi
# A stick minted again may carry a changed service: put it in place for the next start.
if ! cmp -s "$MEDIUM/stick/tomlin-node.service" /etc/systemd/system/tomlin-node.service; then
  cp -f "$MEDIUM/stick/tomlin-node.service" /etc/systemd/system/tomlin-node.service && systemctl daemon-reload >> "$LOG" 2>&1
fi

# ---- Network: a wired card with DHCP ----
have_ip() { ip -4 -o addr show scope global 2>/dev/null | grep -q inet; }
# live-boot sets the wired cards to DHCP itself (ifupdown): give it time before starting a DHCP client of our own,
# so two clients never fight over one card.
if ! have_ip; then
  say "Looking for a network (cable)..."
  for i in $(seq 1 45); do have_ip && break; sleep 1; done
fi
if ! have_ip; then
  mkdir -p /etc/systemd/network
  printf '[Match]\nName=en* eth*\n\n[Network]\nDHCP=yes\n' > /etc/systemd/network/20-tomlin-wired.network
  systemctl start systemd-networkd >> "$LOG" 2>&1 || true
  for i in $(seq 1 30); do have_ip && break; sleep 1; done
  if ! have_ip; then
    for dev in $(ls /sys/class/net | grep -E '^(en|eth)'); do
      ip link set "$dev" up 2>/dev/null
      if command -v dhclient >/dev/null; then dhclient -1 "$dev" >> "$LOG" 2>&1 &
      elif command -v dhcpcd >/dev/null; then dhcpcd -1 "$dev" >> "$LOG" 2>&1 &
      fi
    done
    for i in $(seq 1 20); do have_ip && break; sleep 1; done
  fi
  # systemd-networkd does not write /etc/resolv.conf here (no systemd-resolved): take the name servers from its lease.
  if have_ip && ! grep -q '^nameserver' /etc/resolv.conf 2>/dev/null; then
    dns=$(grep -h '^DNS=' /run/systemd/netif/leases/* 2>/dev/null | head -n1 | cut -d= -f2)
    [ -n "$dns" ] && for d in $dns; do echo "nameserver $d"; done > /etc/resolv.conf
  fi
fi
have_ip && say "Network: $(ip -4 -o addr show scope global | awk '{print $4}' | tr '\n' ' ')" || say "No network yet: plug in a cable. TOMLIN starts anyway."

# ---- The firewall: the node's ports answer the home network only ----
# Debian's live system has no firewall rules of its own (everything is let in). TOMLIN's link port and a cluster's RPC
# servers are let in from home-network addresses only; everything else stays as Debian has it. TOMLIN itself also
# refuses any address that is not on the home network (src/share.ts isPrivateAddress).
if command -v nft >/dev/null 2>&1; then
  nft delete table inet tomlin 2>/dev/null
  if nft -f - >> "$LOG" 2>&1 <<EOF
table inet tomlin {
  set home4 { type ipv4_addr; flags interval; elements = { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 127.0.0.0/8 } }
  chain input {
    type filter hook input priority 0; policy accept;
    tcp dport { $LINK_PORT, 50052-50099 } ip saddr != @home4 drop
    tcp dport { $LINK_PORT, 50052-50099 } ip6 saddr != { fe80::/10, fc00::/7, ::1 } drop
  }
}
EOF
  then say "Firewall: port $LINK_PORT and 50052-50099 open to the home network only."
  else say "  the firewall rules did not load (see $LOG): TOMLIN still refuses addresses outside the home network."; fi
fi

# ---- The clock ----
# Linked PCs refuse sealed requests when the two clocks differ by over 10 minutes, and a PC that also runs Windows
# keeps its hardware clock in local time. So the clock is set once from the network (from a web server's Date line;
# the hardware clock is not written, so Windows' own time stays as it was). Without the internet, the admin PC follows
# this node's clock (src/link.ts learnClock).
if have_ip && getent hosts deb.debian.org >/dev/null 2>&1; then
  d=$("$OPT/node/bin/node" -e "fetch('http://deb.debian.org/', { method: 'HEAD', signal: AbortSignal.timeout(8000) }).then(r => console.log(r.headers.get('date') ?? '')).catch(() => undefined)" 2>/dev/null)
  if [ -n "$d" ] && date -u -s "$d" >/dev/null 2>&1; then say "Clock set from the network: $(date -u '+%Y-%m-%d %H:%M') UTC"
  else say "  the clock could not be set from the network: the admin PC follows this node's clock."; fi
fi

# ---- Packages, once (kept with persistence; without it, at every start) ----
online() { have_ip && getent hosts deb.debian.org >/dev/null 2>&1; }
if [ ! -f "$STATE/.packages-1" ] && online; then
  say "Installing the hardware reading and Vulkan packages (once, a minute or two)..."
  export DEBIAN_FRONTEND=noninteractive
  if apt-get update >> "$LOG" 2>&1 && apt-get install -y --no-install-recommends pciutils dmidecode libgomp1 libvulkan1 mesa-vulkan-drivers vulkan-tools nftables >> "$LOG" 2>&1; then
    touch "$STATE/.packages-1"
  else say "  the packages did not install (see $LOG): TOMLIN runs on the CPU until they do."; fi
fi

# ---- NVIDIA's driver, when that entry was picked and an NVIDIA card has no driver yet ----
if grep -qw 'tomlin.nvidia=1' /proc/cmdline && lspci -n 2>/dev/null | grep -q ' 10de:' && [ ! -e /proc/driver/nvidia/version ]; then
  sb=$(od -An -t u1 /sys/firmware/efi/efivars/SecureBoot-* 2>/dev/null | awk '{print $NF}')
  if [ "$sb" = "1" ]; then
    say "Secure Boot is on: NVIDIA's driver built here is not signed and would not load, so it is not installed. Turn Secure Boot off in this PC's firmware and start this entry again, or use the plain TOMLIN node entry (Vulkan/CPU)."
  elif online; then
    say "Installing NVIDIA's driver (Debian's 550; 10-20 minutes, it is built for this kernel)..."
    export DEBIAN_FRONTEND=noninteractive
    for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do
      [ -f "$f" ] && sed -i -E '/^(Components:|deb )/ { / contrib( |$)/! s/ main( |$)/ main contrib\1/; / non-free( |$)/! s/ main contrib( |$)/ main contrib non-free\1/; / non-free-firmware( |$)/! s/ non-free( |$)/ non-free non-free-firmware\1/ }' "$f"
    done
    apt-get update >> "$LOG" 2>&1
    if ! apt-cache show "linux-headers-$(uname -r)" >/dev/null 2>&1; then
      say "  Debian has moved past this stick's kernel ($(uname -r)), so the driver cannot be built for it. Write the newest Debian live image to the stick with Rufus and mint it again."
    elif apt-get install -y "linux-headers-$(uname -r)" nvidia-driver nvidia-vulkan-icd nvidia-smi firmware-misc-nonfree >> "$LOG" 2>&1; then
      if grep -q '/run/live/persistence/' /proc/mounts; then
        say "NVIDIA's driver is in. Restarting in 10 seconds into the plain TOMLIN node entry..."
        sleep 10; systemctl reboot; exit 0
      else
        say "NVIDIA's driver is in, but this stick has no persistence, so it is lost at power-off. Make the stick again in Rufus with a persistent partition."
      fi
    else say "  NVIDIA's driver did not install (see $LOG)."; fi
  else say "No network to fetch NVIDIA's driver: plug in a cable and start this entry again."; fi
fi

# ---- The plain user TOMLIN runs as, its folders, and what only root can read ----
id -u "$NODE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$STATE" --shell /usr/sbin/nologin "$NODE_USER" >> "$LOG" 2>&1
# The graphics cards: Vulkan and CUDA open /dev/dri and /dev/nvidia*.
for g in video render; do getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" "$NODE_USER" >> "$LOG" 2>&1; done
mkdir -p "$STATE/home"
chown -R "$NODE_USER:$NODE_USER" "$STATE" "$APP"
# The admin key is read by TOMLIN only.
chown "$NODE_USER:$NODE_USER" "$OPT/tomlin-node.json" && chmod 0600 "$OPT/tomlin-node.json"
# "Allow host to turn this PC off": TOMLIN (the plain user) may power the PC off through logind, nothing else.
if [ -d /etc/polkit-1 ] || [ -d /usr/share/polkit-1 ]; then
  mkdir -p /etc/polkit-1/rules.d
  printf '%s\n' 'polkit.addRule(function (action, subject) {' \
    '  if (subject.user == "tomlin-node" && action.id.indexOf("org.freedesktop.login1.power-off") == 0) return polkit.Result.YES;' \
    '});' > /etc/polkit-1/rules.d/50-tomlin-node.rules
fi
# The node's screen: tty1 (no login prompt there on the node entries), written by TOMLIN (src/usbscreen.ts).
chown "$NODE_USER" /dev/tty1 2>/dev/null
mkdir -p /run/tomlin-node && chown "$NODE_USER:$NODE_USER" /run/tomlin-node
# dmidecode (the RAM's speed, for the hardware kind) needs root: read once here for TOMLIN.
command -v dmidecode >/dev/null 2>&1 && dmidecode -t memory > /run/tomlin-node/dmi-memory.txt 2>> "$LOG"

say "Starting TOMLIN..."
exit 0
