# Freedify - Music Streaming Web App

Stream music from anywhere. Search songs, albums, artists, or paste URLs from Spotify, Bandcamp, Archive.org, Phish.in, and more.

## ✨ Features

### 🔍 Search
- **Deezer-powered** - Search tracks, albums, or artists with no rate limits
- **Live Show Search** - Search "Phish 2024" or "Grateful Dead 1977" to find live shows
- **Podcast Search** - Search and stream podcasts via PodcastIndex API
- **URL Import** - Paste links from Spotify, Bandcamp, Soundcloud, Archive.org, Phish.in

### 🎵 Live Show Archives
- **Phish.in** - Search by year/month (e.g., `Phish 2025` or `Phish 2024/12`)
- **Archive.org** - Grateful Dead, Billy Strings, Ween, King Gizzard
- **Direct URLs** - Paste any phish.in or archive.org show URL

### 🎛️ Player Controls
- **Volume Control** - Slider + mute button
- **Repeat Modes** - Off / Repeat All / Repeat One
- **Shuffle** - Shuffle playlist or current queue
- **Fullscreen Mode** - Click album art to expand

### 💾 Download
- **Single Tracks** - Download as `Artist - Song.ext`
- **Full Albums/Playlists** - Batch download as `Artist - Album.zip`
- **Multiple Formats** - FLAC, AIFF, ALAC, WAV, 320kbps MP3
- **Current Track** - Press ⬇ on player bar or fullscreen to download now playing

### ⌨️ Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `Space` | Play/Pause |
| `←` / `→` | Previous/Next track |
| `Shift+←` / `Shift+→` | Seek -/+ 10 seconds |
| `↑` / `↓` | Volume up/down |
| `M` | Mute/Unmute |
| `S` | Shuffle queue |
| `R` | Cycle repeat mode |
| `F` | Toggle fullscreen |
| `Q` | Toggle queue |
| `?` | Show shortcuts help |

### 📋 Queue Management
- **Drag to Reorder** - Drag tracks to rearrange
- **Add All / Shuffle All** - From any album or playlist
- **Smart Preloading** - Next track buffers automatically
- **Click to Navigate** - Click track/artist name to search

### ❤️ Playlist Manager
- **Save Playlists** - Import Spotify/Bandcamp playlist, click "❤️ Save to Favorites"
- **Favorites Tab** - Click the ❤️ Favorites button to view all saved playlists
- **Instant Recall** - Click any saved playlist to load tracks, then Queue All or Shuffle
- **Persistent Storage** - Playlists stored in browser localStorage (survives restarts)
- **Delete Playlists** - Hover over playlist and click 🗑️ to remove

### 📱 Mobile Ready
- **PWA Support** - Install on your phone's home screen
- **Responsive Design** - Works on any screen size
- **320kbps MP3** - High quality streaming

## 🚀 Quick Start

```bash
# Install dependencies
pip install -r app/requirements.txt

# Install FFmpeg (required)
# Windows: winget install ffmpeg
# macOS: brew install ffmpeg
# Linux: apt install ffmpeg

# Run the server
python -m uvicorn app.main:app --port 8000
```

Open http://localhost:8000

## 🌐 Deploy to Render

1. Fork/push this repo to GitHub
2. Go to [render.com](https://render.com) → New **Web Service**
3. Connect your GitHub repo
4. Render auto-detects `render.yaml`
5. Click **Deploy**

Live at `https://your-app.onrender.com`

> **Note:** Free tier may take 30-60s to wake if idle.

## 📁 Project Structure

```
├── app/
│   ├── main.py              # FastAPI server
│   ├── deezer_service.py    # Deezer search (primary)
│   ├── spotify_service.py   # Spotify URL handling
│   ├── live_show_service.py # Phish.in & Archive.org
│   ├── podcast_service.py   # Podcast & Episode search
│   ├── audio_service.py     # yt-dlp + FFmpeg streaming
│   ├── cache.py             # File-based caching
│   └── requirements.txt
├── static/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── manifest.json
└── render.yaml              # Render deployment config
```

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| MP3_BITRATE | 320k | Output MP3 bitrate |
| PORT | 8000 | Server port |

## 📝 Usage Tips

**Live Show Search Examples:**
- `Phish 2025` - All 2025 Phish shows
- `Phish 2024/12` - December 2024 shows
- `Grateful Dead 1977` - 1977 Dead from Archive.org
- `Billy Strings 2023` - 2023 Billy shows

**Supported URL Sources:**
- Spotify (playlists, albums, tracks)
- Bandcamp
- Soundcloud
- YouTube
- Archive.org
- Phish.in
- And 1000+ more via yt-dlp

---
Made with 🎵 by music lovers, for music lovers.
