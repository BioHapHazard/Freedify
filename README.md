# Freedify - Music Streaming Web App

*Last updated: January 2, 2026*

Stream music and podcasts from anywhere. Search songs, albums, artists, podcasts or paste URLs from Spotify, SoundCloud, Bandcamp, Archive.org, Phish.in, and more.

## ✨ Features

### 🧠 AI & Smart Features - Needs Gemini API Key to work
- **AI Radio** - Infinite queue recommendations based on your seed track (prevents genre drift)
- **DJ Mode** - AI-powered mixing tips (transition technique, timing, key compatibility) - accuracy undetermined
- **Mix Analysis** - Learn how to mix compatible tracks by Key and BPM

### 🔍 Search
- **Deezer-powered** - Search tracks, albums, or artists with no rate limits
- **YouTube Music** - Search YT Music catalog with the 🎵 YT Music button
- **Live Show Search** - Search "Phish 2025" or "Grateful Dead 1977" to find live shows
- **Setlist.fm** - Search concert setlists with the 🎤 Setlists button, auto-matches to audio sources
  - Added Setlist Detail Modal to preview shows before listening
- **Podcast Search** - Search and stream podcasts via PodcastIndex API
- **Episode Details** - Click any episode to see full title, description, and publish date
- **URL Import** - Paste links from Spotify, Bandcamp, Soundcloud, Archive.org, Phish.in

### 🎵 Live Show Archives
- **Phish.in** - Search by year/month (e.g., Phish 2025 or Phish 2024/12)
- **Archive.org** - Grateful Dead, Billy Strings, Ween, King Gizzard
- **Direct URLs** - Paste any phish.in or archive.org show URL

### 🧠 ListenBrainz Integration
- **Scrobbling** - Automatically tracks what you listen to (triggers after 50% duration or 4 minutes)
- **Recommendations** - "✨ For You" section offers personalized tracks based on your history
- **Easy Setup** - Configure via `LISTENBRAINZ_TOKEN` environment variable

### 🎛️ Player Controls
- **Volume Control** - Slider + mute button
- **Repeat Modes** - Off / Repeat All / Repeat One
- **Shuffle** - Shuffle playlist or current queue
- **Fullscreen Mode** - Click album art to expand

### 💾 Download & Save
- **Save to Drive** - Direct save to Google Drive (FLAC/AIFF/MP3)
- **Single Tracks** - Download locally as Artist - Song.ext
- **Full Albums/Playlists** - Batch download as Artist - Album.zip
- **Multiple Formats** - FLAC, AIFF, ALAC, WAV, 320kbps MP3
- **Current Track** - Press ⬇ on player bar or fullscreen to download now playing
- **MusicBrainz Metadata** - Downloads enriched with release year, label, and high-res cover art

### 📋 Queue Management
- **Drag to Reorder** - Drag tracks to rearrange
- **Add All / Shuffle All** - From any album or playlist
- **Smart Preloading** - Next track buffers automatically
- **Click to Navigate** - Click track/artist name to search

### 💜 Playlists
- **Add to Playlist** - Click the 🩷 heart icon on any track to add it to a playlist
- **Create Playlists** - Create new playlists on the fly from the Add to Playlist modal
- **Playlists Tab** - Click the 💜 Playlists button to view all saved playlists
- **Delete Songs** - Remove individual songs from any playlist
- **Google Drive Sync** - Playlists sync to Google Drive for access across all your devices
- **Local Backup** - Also stored in browser localStorage (survives restarts)
- **Delete Playlists** - Hover over playlist and click 🗑️ to remove

### 🎛️ Equalizer
- **5-Band EQ** - Adjust 60Hz, 230Hz, 910Hz, 3.6kHz, 7.5kHz
- **Bass Boost** - Extra low-end punch
- **Volume Boost** - Up to +6dB gain
- **Presets** - Flat, Bass Boost, Treble, Vocal

### 🎨 Custom Themes
- **6 Color Themes** - Default, Purple, Blue, Green, Pink, Orange
- **Persistent** - Theme saved to localStorage

### ☁️ Google Drive Sync
- **Save Tracks** - Save audio directly to your "Freedify" folder
- **Cross-Device** - Sync playlists across devices
- **Upload/Download** - Manual sync control
- **Privacy** - Uses Drive appDataFolder (hidden from Drive UI)

### 📱 Mobile Ready
- **PWA Support** - Install on your phone's home screen
- **Responsive Design** - Works on any screen size
- **320kbps MP3** - High quality streaming
- **Lock Screen Controls** - Play/pause/skip from lock screen

---

### ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play/Pause |
| ← / → | Previous/Next track |
| Shift+← / Shift+→ | Seek -/+ 10 seconds |
| ↑ / ↓ | Volume up/down |
| M | Mute/Unmute |
| S | Shuffle queue |
| R | Cycle repeat mode |
| F | Toggle fullscreen |
| Q | Toggle queue |
| ? | Show shortcuts help |

---

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

---

## 🌐 Deploy to Render

1. Fork/push this repo to GitHub
2. Go to render.com → New Web Service
3. Connect your GitHub repo
4. Render auto-detects render.yaml
5. Click Deploy

---

## ⚙️ Environment Variables (Deployment Secrets)

When deploying to Render (or other hosts), set these in your Dashboard:

| Variable | Required? | Description |
|----------|-----------|-------------|
| `GEMINI_API_KEY` | **YES** | Required for AI Radio and DJ Tips |
| `MP3_BITRATE` | No | Default: 320k |
| `PORT` | No | Default: 8000 |

### Optional Spotify Credentials (for high traffic)

If you hit rate limits, you can add your own keys:

| Variable | Description |
|----------|-------------|
| `SPOTIFY_CLIENT_ID` | Your App Client ID |
| `SPOTIFY_CLIENT_SECRET` | Your App Client Secret |
| `SPOTIFY_SP_DC` | Cookie for authenticated web player access |
| `PODCASTINDEX_KEY` | For Podcast Search (better results) |
| `PODCASTINDEX_SECRET` | For Podcast Search (required if KEY is used) |
| `SETLIST_FM_API_KEY` | For Setlist.fm concert search (free at setlist.fm/settings/api) |
| `LISTENBRAINZ_TOKEN` | For Scrobbling & Recommendations (get at listenbrainz.org/settings) |

---

## Live Show Search Examples:

- `Phish 2025` - All 2025 Phish shows
- `Phish 2024/12` - December 2024 shows
- `Grateful Dead 1977` - 1977 Dead from Archive.org
- `KGLW 2025` - 2025 King Gizzard & the Wizard Lizard shows

---

## Setlist.fm Search Examples:

Select **More → Setlists** and search using these formats:

- `Phish 31-12-2025` - Specific date (DD-MM-YYYY format)
- `Phish 2025-12-31` - Specific date (YYYY-MM-DD format) 
- `Phish December 31 2025` - Natural language date
- `Pearl Jam 2024` - All shows from a year

Click a result to see the full setlist with song annotations, then click "Listen on Phish.in" or "Search on Archive.org" to play the show.

---

## Supported URL Sources:

- Spotify (playlists, albums, tracks)
- Bandcamp
- Soundcloud
- YouTube
- Archive.org
- Phish.in
- And 1000+ more via yt-dlp

---

## Credits
Inspired by and built off of [Spotiflac](https://github.com/afkarxyz/Spotiflac) by afkarxyz.

---

Made with 💖 by a music lover, for music lovers.
