# Freedify - Music Streaming Web App

Stream music from anywhere. Search songs, albums, or artists, and paste Spotify links to load entire playlists.

## Features

- 🔍 **Search** - Songs, albums, or artists
- 📋 **Spotify URLs** - Paste album/playlist links to load all tracks
- ➕ **Queue Management** - Add all, clear, reorder
- 📱 **Mobile PWA** - Install on your phone's home screen
- 🎧 **High Quality** - 320kbps MP3 streaming

## Quick Start (Local)

```bash
# Install dependencies
pip install -r app/requirements.txt

# Install FFmpeg (required for transcoding)
# Windows: winget install ffmpeg
# macOS: brew install ffmpeg
# Linux: apt install ffmpeg

# Run the server
python -m uvicorn app.main:app --port 8000
```

Open http://localhost:8000

## Deploy to Render

1. Fork/push this repo to GitHub
2. Go to [render.com](https://render.com) and create a new **Web Service**
3. Connect your GitHub repo
4. Render will auto-detect the `render.yaml` configuration
5. Click **Deploy**

Your app will be live at `https://freedify-XXXX.onrender.com`

> **Note:** Free tier may take 30-60 seconds to wake up if idle.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| MP3_BITRATE | 320k | Output MP3 bitrate |
| PORT | 8000 | Server port |

## Project Structure

```
├── app/
│   ├── main.py           # FastAPI server
│   ├── spotify_service.py # Spotify search & metadata
│   ├── audio_service.py  # Tidal/Deezer download + FFmpeg
│   ├── cache.py          # File-based caching
│   └── requirements.txt
├── static/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── manifest.json
└── render.yaml           # Render deployment config
```
