# Freedify on Proxmox VE

Run Freedify in a lightweight Alpine Linux LXC container on Proxmox VE with a single command!

## 🚀 Quick Start

Run this command on your Proxmox VE host:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/tanujdargan/Freedify/main/proxmox-freedify-install.sh)"
```

Or using curl:

```bash
bash <(curl -s https://raw.githubusercontent.com/tanujdargan/Freedify/main/proxmox-freedify-install.sh)
```

The installer will:
1. ✅ Download the Alpine Linux template
2. ✅ Create an LXC container with your specifications
3. ✅ Install Python 3, FFmpeg, and all dependencies
4. ✅ Clone the Freedify repository
5. ✅ Configure the service to start on boot
6. ✅ Start Freedify automatically

## 📋 Requirements

- Proxmox VE 7.0 or later
- Internet connection for downloading packages
- Storage space for the container (recommended: 4GB minimum)

## ⚙️ Container Specifications

### Default Configuration
- **OS**: Alpine Linux 3.19 (lightweight!)
- **Disk**: 4GB
- **RAM**: 1024MB
- **CPU Cores**: 2
- **Network**: DHCP (configurable)
- **Port**: 8000 (configurable)

### Resource Usage
Alpine Linux keeps the container extremely lightweight:
- Base OS: ~130MB
- With Freedify installed: ~300-400MB
- Runtime memory: ~200-500MB (depending on usage)

## 🎛️ Installation Options

During installation, you'll be prompted for:

### Required Settings
- **CT ID**: Container ID (auto-assigned if not specified)
- **Container Name**: Default is "freedify"
- **Disk Size**: Storage size in GB
- **RAM**: Memory allocation in MB
- **CPU Cores**: Number of CPU cores
- **Network**: DHCP or manual IP configuration
- **Port**: Web interface port (default: 8000)

### Optional API Keys
You can configure these during installation or add them later:
- **Gemini API Key**: For AI Radio and DJ Mode features
- **Genius Access Token**: For lyrics support
- **ListenBrainz Token**: For scrobbling and recommendations

## 🔧 Post-Installation

### Accessing Freedify
After installation, access Freedify at:
```
http://<CONTAINER_IP>:8000
```

The installer will display the container's IP address when complete.

### Managing the Service

#### From Proxmox Host
```bash
# Restart service
pct exec <CTID> -- rc-service freedify restart

# Stop service
pct exec <CTID> -- rc-service freedify stop

# Start service
pct exec <CTID> -- rc-service freedify start

# Check status
pct exec <CTID> -- rc-service freedify status

# Access container shell
pct enter <CTID>
```

#### From Inside Container
```bash
# Enter the container first
pct enter <CTID>

# Then use these commands
rc-service freedify restart
rc-service freedify stop
rc-service freedify start
rc-service freedify status
```

### Adding/Updating API Keys

1. Edit the environment file:
```bash
pct exec <CTID> -- vi /opt/freedify/.env
```

2. Add your API keys:
```env
GEMINI_API_KEY=your_key_here
GENIUS_ACCESS_TOKEN=your_token_here
LISTENBRAINZ_TOKEN=your_token_here
SPOTIFY_CLIENT_ID=your_id_here
SPOTIFY_CLIENT_SECRET=your_secret_here
TICKETMASTER_API_KEY=your_key_here
```

3. Restart the service:
```bash
pct exec <CTID> -- rc-service freedify restart
```

## 🔄 Updating Freedify

To update to the latest version of Freedify:

### Option 1: Using the Update Script
```bash
# From Proxmox host
bash <(curl -s https://raw.githubusercontent.com/tanujdargan/Freedify/main/proxmox-freedify-update.sh) <CTID>
```

### Option 2: Manual Update
```bash
# Enter the container
pct enter <CTID>

# Stop the service
rc-service freedify stop

# Update the repository
cd /opt/freedify
git pull origin main

# Update dependencies
pip3 install --upgrade -r app/requirements.txt --break-system-packages

# Start the service
rc-service freedify start
```

## 🐛 Troubleshooting

### Service Won't Start
```bash
# Check service status
pct exec <CTID> -- rc-service freedify status

# Check if port is already in use
pct exec <CTID> -- netstat -tulpn | grep 8000

# Check Python dependencies
pct exec <CTID> -- pip3 list | grep -i fastapi
```

### Can't Access Web Interface
```bash
# Verify container is running
pct status <CTID>

# Check container IP
pct exec <CTID> -- hostname -i

# Test from Proxmox host
curl http://<CONTAINER_IP>:8000/api/health
```

### Container Out of Space
```bash
# Check disk usage
pct exec <CTID> -- df -h

# Clear cache
pct exec <CTID> -- rm -rf /opt/freedify/cache/*

# Or resize the container disk
pct resize <CTID> rootfs +2G
```

### Update System Packages
```bash
pct exec <CTID> -- apk update
pct exec <CTID> -- apk upgrade
```

## 🗑️ Uninstallation

To completely remove Freedify:

```bash
# Stop and destroy the container
pct stop <CTID>
pct destroy <CTID>
```

## 📁 File Locations

Inside the container:
- **Application**: `/opt/freedify`
- **Environment**: `/opt/freedify/.env`
- **Cache**: `/opt/freedify/cache`
- **Service**: `/etc/init.d/freedify`
- **Logs**: Check with `rc-service freedify status`

## 🔐 Security Notes

1. The container runs as **unprivileged** for security
2. Consider using a **reverse proxy** (nginx/traefik) for HTTPS
3. **Firewall**: Only expose port 8000 to trusted networks
4. **API Keys**: Keep your `.env` file secure and never commit it to git

## 🌐 Network Configuration

### Static IP Configuration
If you chose manual IP during installation, the network is configured in:
```bash
pct config <CTID> | grep net0
```

To change network settings:
```bash
pct set <CTID> -net0 name=eth0,bridge=vmbr0,ip=192.168.1.100/24,gw=192.168.1.1
```

### Port Forwarding
To access Freedify from outside your network, configure port forwarding on your router:
```
External Port: 8000 → Internal IP:Port: <CONTAINER_IP>:8000
```

Or use Proxmox port forwarding with iptables.

## 💡 Advanced Configuration

### Increase Cache Size
Edit `/opt/freedify/.env`:
```env
MAX_CACHE_SIZE_MB=1000
CACHE_TTL_HOURS=48
```

### Change Audio Quality
Edit `/opt/freedify/.env`:
```env
MP3_BITRATE=320k  # Options: 128k, 192k, 256k, 320k
```

### Enable Auto-Start on Boot
```bash
pct set <CTID> -onboot 1
```

### Take Snapshots (Backup)
```bash
# Create a snapshot before major updates
pct snapshot <CTID> freedify-backup-$(date +%Y%m%d)

# List snapshots
pct listsnapshot <CTID>

# Rollback to snapshot
pct rollback <CTID> <snapshot-name>
```

## 🤝 Support

- **GitHub Issues**: https://github.com/tanujdargan/Freedify/issues
- **Main README**: https://github.com/tanujdargan/Freedify/blob/main/README.md

## 📝 License

This installation script is provided under the MIT License, same as Freedify.

---

**Enjoy your lightweight, self-hosted music streaming experience!** 🎵
