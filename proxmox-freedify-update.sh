#!/usr/bin/env bash

# Freedify Update Script for Proxmox VE LXC
# https://github.com/tanujdargan/Freedify
#
# Usage: Run inside the Freedify container or from Proxmox host with CTID
#

set -e

# Color codes
RD="\033[01;31m"
YW="\033[33m"
GN="\033[1;92m"
CL="\033[m"
BFR="\\r\\033[K"
HOLD="-"
CM="${GN}✓${CL}"
CROSS="${RD}✗${CL}"

msg_info() {
    echo -ne " ${HOLD} ${YW}$1${CL}..."
}

msg_ok() {
    echo -e "${BFR} ${CM} ${GN}$1${CL}"
}

msg_error() {
    echo -e "${BFR} ${CROSS} ${RD}$1${CL}"
}

# Check if running inside container or from Proxmox host
if [[ -f /.dockerenv ]] || [[ -f /run/.containerenv ]] || [[ -d /opt/freedify ]]; then
    # Running inside container
    EXEC_CMD=""
else
    # Running from Proxmox host
    if [[ -z "$1" ]]; then
        msg_error "Please provide container ID: $0 <CTID>"
        exit 1
    fi
    CTID=$1
    EXEC_CMD="pct exec $CTID --"
    echo -e "${YW}Updating Freedify in container $CTID${CL}\n"
fi

# Stop service
msg_info "Stopping Freedify service"
$EXEC_CMD rc-service freedify stop 2>/dev/null || true
msg_ok "Service stopped"

# Backup current installation
msg_info "Creating backup"
$EXEC_CMD cp -r /opt/freedify /opt/freedify.backup.$(date +%Y%m%d_%H%M%S)
msg_ok "Backup created"

# Update repository
msg_info "Pulling latest changes from GitHub"
$EXEC_CMD sh -c "cd /opt/freedify && git fetch origin && git reset --hard origin/main"
msg_ok "Repository updated"

# Update system packages
msg_info "Updating Alpine packages"
$EXEC_CMD apk update && $EXEC_CMD apk upgrade
msg_ok "System packages updated"

# Update Python dependencies
msg_info "Updating Python dependencies"
$EXEC_CMD sh -c "cd /opt/freedify && pip3 install --upgrade --no-cache-dir -r app/requirements.txt --break-system-packages"
msg_ok "Python dependencies updated"

# Clear cache
msg_info "Clearing cache"
$EXEC_CMD rm -rf /opt/freedify/cache/*
msg_ok "Cache cleared"

# Start service
msg_info "Starting Freedify service"
$EXEC_CMD rc-service freedify start
sleep 2
msg_ok "Service started"

# Check service status
if $EXEC_CMD rc-service freedify status &>/dev/null; then
    echo -e "\n${GN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
    echo -e "${GN}  ✓ Freedify Updated Successfully!${CL}"
    echo -e "${GN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}\n"
else
    msg_error "Service failed to start. Check logs with: pct exec $CTID -- rc-service freedify status"
    exit 1
fi
