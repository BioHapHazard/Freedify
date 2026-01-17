#!/usr/bin/env bash

# Freedify LXC Setup Script for Proxmox VE
# https://github.com/tanujdargan/Freedify
#
# Usage: bash -c "$(wget -qLO - https://raw.githubusercontent.com/tanujdargan/Freedify/main/proxmox-freedify-install.sh)"
#

# Copyright (c) 2021-2024 community-scripts
# Author: Freedify Contributors
# License: MIT

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

# Functions
msg_info() {
    echo -ne " ${HOLD} ${YW}$1${CL}..."
}

msg_ok() {
    echo -e "${BFR} ${CM} ${GN}$1${CL}"
}

msg_error() {
    echo -e "${BFR} ${CROSS} ${RD}$1${CL}"
}

# Check if running on Proxmox VE
if ! command -v pveversion &> /dev/null; then
    msg_error "This script must be run on Proxmox VE"
    exit 1
fi

# Default variables
CTID=""
CT_NAME="freedify"
DISK_SIZE="4"
RAM="1024"
CORES="2"
BRIDGE="vmbr0"
VLAN=""
NET="dhcp"
IPV4=""
GATEWAY=""
NETMASK=""
DNS=""
PORT="8000"
STORAGE="local-lxc"

# Function to get next available CTID
get_next_ctid() {
    local ctid=100
    while pct status $ctid &>/dev/null; do
        ((ctid++))
    done
    echo $ctid
}

# Header
clear
cat << "EOF"
    ______                 ___  _____
   / ____/_______  ___  __/ (_)/ __(_)__  __
  / /_  / ___/ _ \/ _ \/ __ / / /_/ / / / /
 / __/ / /  /  __/  __/ /_/ / / __/ / /_/ /
/_/   /_/   \___/\___/\__,_/_/_/ /_/\__, /
                                   /____/
EOF
echo -e "\n${GN}Proxmox VE LXC Container Setup${CL}\n"

# User input
echo -e "${YW}Container Configuration${CL}"
read -p "Enter CT ID (default: auto): " CTID_INPUT
CTID=${CTID_INPUT:-$(get_next_ctid)}

read -p "Enter Container Name (default: freedify): " CT_NAME_INPUT
CT_NAME=${CT_NAME_INPUT:-$CT_NAME}

read -p "Enter Disk Size in GB (default: 4): " DISK_SIZE_INPUT
DISK_SIZE=${DISK_SIZE_INPUT:-$DISK_SIZE}

read -p "Enter RAM in MB (default: 1024): " RAM_INPUT
RAM=${RAM_INPUT:-$RAM}

read -p "Enter CPU Cores (default: 2): " CORES_INPUT
CORES=${CORES_INPUT:-$CORES}

read -p "Enter Bridge (default: vmbr0): " BRIDGE_INPUT
BRIDGE=${BRIDGE_INPUT:-$BRIDGE}

read -p "Enter VLAN (default: none): " VLAN_INPUT
VLAN=${VLAN_INPUT}

read -p "Use DHCP? (y/n, default: y): " USE_DHCP
if [[ "${USE_DHCP,,}" == "n" ]]; then
    read -p "Enter IPv4 Address (CIDR): " IPV4
    read -p "Enter Gateway: " GATEWAY
    NET="manual"
fi

read -p "Enter Freedify Port (default: 8000): " PORT_INPUT
PORT=${PORT_INPUT:-$PORT}

read -p "Enter Storage Location (default: local-lxc): " STORAGE_INPUT
STORAGE=${STORAGE_INPUT:-$STORAGE}

echo -e "\n${YW}Optional API Keys (press Enter to skip)${CL}"
read -p "Gemini API Key (for AI Radio/DJ): " GEMINI_API_KEY
read -p "Genius Access Token (for lyrics): " GENIUS_ACCESS_TOKEN
read -p "ListenBrainz Token (for scrobbling): " LISTENBRAINZ_TOKEN

# Confirmation
echo -e "\n${YW}Container Summary:${CL}"
echo "  CT ID:       $CTID"
echo "  Name:        $CT_NAME"
echo "  Disk:        ${DISK_SIZE}GB"
echo "  RAM:         ${RAM}MB"
echo "  Cores:       $CORES"
echo "  Network:     $NET"
echo "  Port:        $PORT"
echo ""
read -p "Continue with installation? (y/n): " CONFIRM
if [[ "${CONFIRM,,}" != "y" ]]; then
    msg_error "Installation cancelled"
    exit 0
fi

# Download Alpine template
msg_info "Downloading Alpine Linux template"
if ! pveam list $STORAGE | grep -q "alpine-3.19-default"; then
    pveam download $STORAGE alpine-3.19-default_20231219_amd64.tar.xz
fi
msg_ok "Alpine template ready"

# Network configuration
if [[ "$NET" == "dhcp" ]]; then
    NET_CONFIG="name=eth0,bridge=$BRIDGE,ip=dhcp"
else
    NET_CONFIG="name=eth0,bridge=$BRIDGE,ip=$IPV4,gw=$GATEWAY"
fi

if [[ -n "$VLAN" ]]; then
    NET_CONFIG="$NET_CONFIG,tag=$VLAN"
fi

# Create container
msg_info "Creating LXC container"
pct create $CTID $STORAGE:vztmpl/alpine-3.19-default_20231219_amd64.tar.xz \
    -hostname $CT_NAME \
    -cores $CORES \
    -memory $RAM \
    -swap 512 \
    -net0 $NET_CONFIG \
    -storage $STORAGE \
    -rootfs $STORAGE:$DISK_SIZE \
    -unprivileged 1 \
    -features nesting=1 \
    -onboot 1 \
    -timezone host
msg_ok "Container created (ID: $CTID)"

# Start container
msg_info "Starting container"
pct start $CTID
sleep 5
msg_ok "Container started"

# Function to execute commands in container
lxc_exec() {
    pct exec $CTID -- bash -c "$1"
}

# Update Alpine and install dependencies
msg_info "Updating Alpine Linux"
lxc_exec "apk update && apk upgrade"
msg_ok "Alpine updated"

msg_info "Installing system dependencies"
lxc_exec "apk add --no-cache python3 py3-pip ffmpeg git curl ca-certificates tzdata"
msg_ok "System dependencies installed"

# Create app directory
msg_info "Setting up Freedify"
lxc_exec "mkdir -p /opt/freedify"
msg_ok "App directory created"

# Clone repository
msg_info "Cloning Freedify repository"
lxc_exec "git clone https://github.com/tanujdargan/Freedify.git /opt/freedify"
msg_ok "Repository cloned"

# Install Python dependencies
msg_info "Installing Python dependencies (this may take a few minutes)"
lxc_exec "cd /opt/freedify && pip3 install --no-cache-dir -r app/requirements.txt --break-system-packages"
msg_ok "Python dependencies installed"

# Create cache directory
msg_info "Creating cache directory"
lxc_exec "mkdir -p /opt/freedify/cache && chmod 755 /opt/freedify/cache"
msg_ok "Cache directory created"

# Create environment file
msg_info "Configuring environment"
ENV_CONTENT="PORT=$PORT
MP3_BITRATE=320k
CACHE_DIR=/opt/freedify/cache
MAX_CACHE_SIZE_MB=500
CACHE_TTL_HOURS=24"

if [[ -n "$GEMINI_API_KEY" ]]; then
    ENV_CONTENT="$ENV_CONTENT
GEMINI_API_KEY=$GEMINI_API_KEY"
fi

if [[ -n "$GENIUS_ACCESS_TOKEN" ]]; then
    ENV_CONTENT="$ENV_CONTENT
GENIUS_ACCESS_TOKEN=$GENIUS_ACCESS_TOKEN"
fi

if [[ -n "$LISTENBRAINZ_TOKEN" ]]; then
    ENV_CONTENT="$ENV_CONTENT
LISTENBRAINZ_TOKEN=$LISTENBRAINZ_TOKEN"
fi

lxc_exec "cat > /opt/freedify/.env << 'ENVEOF'
$ENV_CONTENT
ENVEOF"
msg_ok "Environment configured"

# Create OpenRC service
msg_info "Creating system service"
lxc_exec "cat > /etc/init.d/freedify << 'SERVICEEOF'
#!/sbin/openrc-run

name=\"Freedify\"
description=\"Freedify Music Streaming Service\"

command=\"/usr/bin/python3\"
command_args=\"-m uvicorn app.main:app --host 0.0.0.0 --port $PORT\"
command_background=true
pidfile=\"/run/freedify.pid\"
directory=\"/opt/freedify\"

depend() {
    need net
    after firewall
}

start_pre() {
    checkpath --directory --mode 0755 --owner root:root /opt/freedify/cache
}
SERVICEEOF"

lxc_exec "chmod +x /etc/init.d/freedify"
lxc_exec "rc-update add freedify default"
msg_ok "Service created"

# Start service
msg_info "Starting Freedify service"
lxc_exec "rc-service freedify start"
sleep 3
msg_ok "Service started"

# Get container IP
if [[ "$NET" == "dhcp" ]]; then
    sleep 5
    CONTAINER_IP=$(pct exec $CTID -- hostname -i | awk '{print $1}')
else
    CONTAINER_IP=$(echo $IPV4 | cut -d'/' -f1)
fi

# Final message
echo -e "\n${GN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
echo -e "${GN}  ✓ Freedify Installation Complete!${CL}"
echo -e "${GN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
echo -e "\n${YW}Container Details:${CL}"
echo -e "  • CT ID:        ${GN}$CTID${CL}"
echo -e "  • Name:         ${GN}$CT_NAME${CL}"
echo -e "  • IP Address:   ${GN}$CONTAINER_IP${CL}"
echo -e "  • Port:         ${GN}$PORT${CL}"
echo -e "\n${YW}Access Freedify:${CL}"
echo -e "  ${GN}http://$CONTAINER_IP:$PORT${CL}"
echo -e "\n${YW}Useful Commands:${CL}"
echo -e "  • View logs:     ${GN}pct exec $CTID -- tail -f /var/log/freedify.log${CL}"
echo -e "  • Restart:       ${GN}pct exec $CTID -- rc-service freedify restart${CL}"
echo -e "  • Stop:          ${GN}pct exec $CTID -- rc-service freedify stop${CL}"
echo -e "  • Shell access:  ${GN}pct enter $CTID${CL}"
echo -e "\n${YW}To add API keys later:${CL}"
echo -e "  ${GN}pct exec $CTID -- vi /opt/freedify/.env${CL}"
echo -e "  ${GN}pct exec $CTID -- rc-service freedify restart${CL}"
echo -e "\n${GN}Enjoy your music! 🎵${CL}\n"
