#!/bin/sh
# TOMLIN node (Bootable USB): live-config hook, run as root early in a boot of the "TOMLIN node" entry (before the
# network). With persistence, live-config may run it on the first boot only (it marks what it has done), so what it
# puts in place is kept and works on later boots too: the service, started at every boot, runs start.sh straight from
# the stick. Named on the kernel line as live-config.hooks=file:///run/live/medium/tomlin/hook.sh
set -u
grep -qw 'tomlin.node=1' /proc/cmdline || exit 0

MEDIUM=/run/live/medium/tomlin
LOG=/var/log/tomlin-node-setup.log
mkdir -p /opt/tomlin
echo "$(date -Is) hook: start" >> "$LOG"

# The plain user TOMLIN runs as (the service names it; it must be there before the service starts).
id -u tomlin-node >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/tomlin-node --shell /usr/sbin/nologin tomlin-node >> "$LOG" 2>&1

cp -f "$MEDIUM/stick/tomlin-node.service" /etc/systemd/system/tomlin-node.service
mkdir -p /etc/systemd/system/multi-user.target.wants
ln -sf /etc/systemd/system/tomlin-node.service /etc/systemd/system/multi-user.target.wants/tomlin-node.service

# The node's screen takes tty1 when booted as a node: no login prompt there then (Alt+F2 still gives one). Only for
# the TOMLIN node entries: the stick's own Debian entries share the persistence and keep their tty1 login.
mkdir -p /etc/systemd/system/getty@tty1.service.d
printf '[Unit]\nConditionKernelCommandLine=!tomlin.node=1\n' > /etc/systemd/system/getty@tty1.service.d/tomlin-node.conf

systemctl daemon-reload >> "$LOG" 2>&1 || true
systemctl --no-block start tomlin-node.service >> "$LOG" 2>&1 || true
echo "$(date -Is) hook: done" >> "$LOG"
exit 0
