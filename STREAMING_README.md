# SpotiFLAC Streaming Server

A self-hosted music streaming server that lets you search and stream music from Spotify/Tidal/Deezer.

## Quick Start

### Local Development

```bash
# Install dependencies
cd spotiflac-main
pip install -r app/requirements.txt

# Run the server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 in your browser.

### Deploy to Render

1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com/)
3. Click "New" → "Web Service"
4. Connect your GitHub repo
5. Use these settings:
   - **Runtime**: Python
   - **Build Command**: `pip install -r app/requirements.txt`
   - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

Or use the `render.yaml` blueprint for automatic configuration.

## Features

- 🔍 Search tracks via Spotify
- 🎵 Stream from Tidal/Deezer (FLAC → MP3 320kbps)
- 📱 Mobile-friendly PWA (add to home screen)
- 🎧 Lock screen / notification controls
- 📋 Queue management
- ⚡ Automatic caching for faster replays

## Requirements

- Python 3.9+
- FFmpeg (pre-installed on Render)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8000 | Server port |
| `CACHE_DIR` | /tmp/spotiflac_cache | Cache directory |
| `MAX_CACHE_SIZE_MB` | 500 | Max cache size |
| `MP3_BITRATE` | 320k | Transcode bitrate |
