"""
Audio service for fetching and transcoding music.
Fetches FLAC from Tidal/Deezer and transcodes to MP3 using FFmpeg.
Uses multiple API endpoints with fallback for reliability.
"""
import os
import subprocess
import asyncio
import httpx
import base64
from typing import Optional, Dict, Any, List, Union
import logging
import json
import tempfile
from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TRCK, TDRC, TCON, APIC, COMM
from mutagen.mp3 import MP3, EasyMP3
from mutagen.mp4 import MP4, MP4Cover

import re
from app.cache import is_cached, get_cached_file, cache_file, get_cache_path

logger = logging.getLogger(__name__)

# Configuration
BITRATE = os.environ.get("MP3_BITRATE", "320k")
DEEZER_API_URL = os.environ.get("DEEZER_API_URL", "https://api.deezmate.com")
USER_AGENT = "Freedify/1.0 (Cross-Platform; Python) httpx/0.27"

# FFmpeg path - check common locations on Windows
FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")
if os.name == 'nt' and FFMPEG_PATH == "ffmpeg":
    # Try common Windows locations
    winget_path = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages")
    if os.path.exists(winget_path):
        for root, dirs, files in os.walk(winget_path):
            if "ffmpeg.exe" in files:
                FFMPEG_PATH = os.path.join(root, "ffmpeg.exe")
                break

# List of Tidal hifi-api endpoints with fallback.
# These are community-hosted reverse proxies in front of a logged-in Tidal session.
# They share the same hifi-api schema (/search/, /track/, /trackManifests/) but only
# instances whose upstream Tidal token is alive can actually return a stream manifest;
# the rest answer search but 403 on /track/ ("Upstream API error").
# Ordering: known streaming-capable instances first. Live status is refreshed at
# runtime from TIDAL_UPTIME_FEED (see update_tidal_apis).
TIDAL_APIS = [
    "https://hifi.binimum.org",            # hifi-api v2.10 — streaming-capable (DASH FLAC)
    "https://eu-central.monochrome.tf",    # monochrome v2.10 (EU)
    "https://us-west.monochrome.tf",       # monochrome v2.10 (US)
    "https://hifi-api.kennyy.com.br",      # hifi-api v2.10
    "https://api.monochrome.tf",           # monochrome official (v2.5)
    "https://monochrome-api.samidy.com",   # monochrome mirror (v2.3)
    "https://tidal.squid.wtf",             # squid.wtf Tidal proxy
]

# Live health/instance feed (JSON). Lists currently-up api/streaming instances.
TIDAL_UPTIME_FEED = "https://tidal-uptime.geeked.wtf/"

# ============================================================
# FEATURE FLAGS
# ============================================================
ENABLE_QOBUZ = True    # Qobuz via dab.yeet.su / dabmusic.xyz / squid.wtf
ENABLE_DAB   = False   # Dab Music standalone — folded into Qobuz fallback chain

# Parallel proxy racing timeout (seconds per attempt)
PROXY_RACE_TIMEOUT = 8.0
# Max proxies to race in parallel (top N from sorted list)
PROXY_RACE_COUNT = 3


class AudioService:
    """Service for fetching and transcoding audio."""

    # Tidal credentials
    TIDAL_CLIENT_ID = base64.b64decode("NkJEU1JkcEs5aHFFQlRnVQ==").decode()
    TIDAL_CLIENT_SECRET = base64.b64decode("eGV1UG1ZN25icFo5SUliTEFjUTkzc2hrYTFWTmhlVUFxTjZJY3N6alRHOD0=").decode()

    # In-memory album art cache to avoid re-downloading the same cover per album
    _art_cache: dict = {}
    _ART_CACHE_MAX = 20

    async def _cached_fetch_art(self, url: str) -> bytes | None:
        """Fetch album art with simple LRU cache (bounded to _ART_CACHE_MAX entries)."""
        if url in self._art_cache:
            return self._art_cache[url]
        try:
            resp = await self.client.get(url)
            if resp.status_code == 200:
                if len(self._art_cache) >= self._ART_CACHE_MAX:
                    self._art_cache.pop(next(iter(self._art_cache)))
                self._art_cache[url] = resp.content
                return resp.content
        except Exception as e:
            logger.debug(f"Failed to fetch album art from {url}: {e}")
        return None

    async def import_url(self, url: str) -> Optional[Dict[str, Any]]:
        """Import track or playlist from URL using yt-dlp."""
        try:
            # Phish.in Custom Handler (Fast Path)
            if "phish.in" in url:
                logger.info("Detected Phish.in URL, using custom API handler")
                phish_data = await self._import_phish_in(url)
                if phish_data: return phish_data

            loop = asyncio.get_event_loop()
            info = await loop.run_in_executor(None, lambda: self._extract_info_safe(url))
            
            if not info:
                return None
            
            # Check if it's a playlist/album
            if 'entries' in info and info['entries']:
                logger.info(f"Detected playlist: {info.get('title')}")
                tracks = []
                for entry in info['entries']:
                    if not entry: continue
                    
                    # Determine playback URL (webpage_url for recalculation, or direct url)
                    # For stability, we prefer the webpage_url if it's a separate page, 
                    # OR we use the original URL with an index? 
                    # Ideally, entry has 'webpage_url' or 'url'.
                    # For yt-dlp, 'url' might be the stream url (which expires). 'webpage_url' is persistent.
                    play_url = entry.get('webpage_url') or entry.get('url')
                    if not play_url: continue

                    safe_t_id = f"LINK:{base64.urlsafe_b64encode(play_url.encode()).decode()}"
                    duration_s = entry.get('duration', 0)
                    
                    tracks.append({
                        'id': safe_t_id,
                        'name': entry.get('title', 'Unknown Title'),
                        'artists': entry.get('uploader', entry.get('artist', 'Unknown Artist')),
                        'album_art': entry.get('thumbnail', info.get('thumbnail', '/static/icon.svg')),
                        'duration': f"{int(duration_s // 60)}:{int(duration_s % 60):02d}",
                        'album': info.get('title', 'Imported Playlist'),
                        'isrc': safe_t_id # Use ID as ISRC for internal logic
                    })
                
                if not tracks: return None

                return {
                    'type': 'album',
                    'id': f"LINK:{base64.urlsafe_b64encode(url.encode()).decode()}",
                    'name': info.get('title', 'Imported Playlist'),
                    'artists': info.get('uploader', 'Various'),
                    'image': info.get('thumbnail', '/static/icon.svg'), # Use album art
                    'release_date': info.get('upload_date', ''),
                    'tracks': tracks,
                    'total_tracks': len(tracks),
                    'is_custom': True
                }

            # Single Track Logic
            safe_id = f"LINK:{base64.urlsafe_b64encode(url.encode()).decode()}"
            duration_s = info.get('duration', 0)
            
            track = {
                'id': safe_id,
                'name': info.get('title', 'Unknown Title'),
                'artists': info.get('uploader', info.get('artist', 'Unknown Artist')),
                'album_art': info.get('thumbnail', '/static/icon.svg'),
                'duration': f"{int(duration_s // 60)}:{int(duration_s % 60):02d}",
                'album': info.get('extractor_key', 'Imported'),
                'isrc': safe_id
            }
            return track
        except Exception as e:
            logger.error(f"Import error: {e}")
            return None

    def _extract_info_safe(self, url):
        try:
            import yt_dlp
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'format': 'bestaudio/best',
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(url, download=False)
        except Exception as e:
            logger.error(f"yt-dlp error: {e}")
            return None

    async def _import_phish_in(self, url: str) -> Optional[Dict[str, Any]]:
        """Import show from Phish.in API."""
        try:
            # Extract date YYYY-MM-DD
            match = re.search(r'(\d{4}-\d{2}-\d{2})', url)
            if not match:
                logger.warning("Could not extract date from Phish.in URL")
                return None
            
            date = match.group(1)
            api_url = f"https://phish.in/api/v2/shows/{date}"
            
            logger.info(f"Fetching Phish.in API: {api_url}")
            async with httpx.AsyncClient() as client:
                response = await client.get(api_url, timeout=15.0)
                if response.status_code != 200:
                    return None
                
                data = response.json()
                
                tracks_list = []
                show_meta = {}

                # Handle v2 (List of tracks? or Object with tracks?)
                # Swagger says implementation differs. Based on curl, likely a List.
                if isinstance(data, list):
                     tracks_list = data
                     if tracks_list:
                         show_meta = tracks_list[0]
                elif isinstance(data, dict):
                    if 'data' in data: data = data['data']
                    if 'tracks' in data:
                        tracks_list = data['tracks']
                        show_meta = data
                    else:
                        # Maybe data IS the track list?
                        pass

                if not tracks_list: return None
                
                tracks = []
                # extracting metadata
                venue = show_meta.get('venue_name', show_meta.get('venue', {}).get('name', 'Unknown Venue'))
                show_date = show_meta.get('show_date', show_meta.get('date', date))
                
                album_name = f"{show_date} - {venue}"
                
                for t in tracks_list:
                    # mp3 url is usually http, ensure https if possible or leave as is
                    mp3_url = t.get('mp3_url') or t.get('mp3')
                    if not mp3_url: continue
                    
                    safe_id = f"LINK:{base64.urlsafe_b64encode(mp3_url.encode()).decode()}"
                    duration_s = t.get('duration', 0) / 1000.0 if t.get('duration', 0) > 10000 else t.get('duration', 0) 
                    # v2 duration seems to be ms? curl say 666600 (666s = 11m). So ms.
                    
                    tracks.append({
                        'id': safe_id,
                        'name': t.get('title', 'Unknown'),
                        'artists': 'Phish',
                        'album': album_name,
                        'album_art': t.get('show_album_cover_url', '/static/icon.svg'), 
                        'duration': f"{int(duration_s // 60)}:{int(duration_s % 60):02d}",
                        'isrc': safe_id
                    })
                
                if not tracks: return None
                
                return {
                    'type': 'album',
                    'id': f"LINK:{base64.urlsafe_b64encode(url.encode()).decode()}",
                    'name': album_name,
                    'artists': 'Phish',
                    'image': tracks[0]['album_art'],
                    'release_date': show_date,
                    'tracks': tracks,
                    'total_tracks': len(tracks),
                    'is_custom': True
                }
        except Exception as e:
            logger.error(f"Phish.in import error: {e}")
            return None

    def _get_stream_url(self, url: str) -> Optional[str]:
        """Get the actual stream URL from a page URL using yt-dlp.
        For direct audio files (.mp3, .m4a, etc.), return as-is.
        """
        # Check if URL is already a direct audio file
        from urllib.parse import urlparse
        parsed = urlparse(url)
        path_lower = parsed.path.lower()
        audio_extensions = ('.mp3', '.m4a', '.ogg', '.wav', '.aac', '.flac', '.opus')
        if any(path_lower.endswith(ext) for ext in audio_extensions):
            logger.info(f"Direct audio URL detected, bypassing yt-dlp: {url[:60]}...")
            return url
        
        
        # Check cache
        import time
        now = time.time()
        if url in self._stream_url_cache:
            cached_url, expiry = self._stream_url_cache[url]
            if now < expiry:
                logger.info("Stream URL cache hit")
                return cached_url
            else:
                del self._stream_url_cache[url]
        
        # Use yt-dlp for page URLs (YouTube, Bandcamp, SoundCloud, etc.)
        info = self._extract_info_safe(url)
        if not info: return None
        if 'entries' in info: info = info['entries'][0]

        # Prefer non-HLS progressive HTTP streams for browser compatibility.
        # HLS (m3u8) URLs cannot be proxied directly — the browser receives the
        # playlist text, not audio segments, and plays silently or errors.
        stream_url = None
        formats = info.get('formats', [])
        if formats:
            # Audio-only non-HLS formats, sorted by bitrate descending
            http_audio = [
                f for f in formats
                if f.get('url')
                and f.get('protocol', 'http') not in ('m3u8', 'm3u8_native')
                and (f.get('vcodec') in (None, 'none') or f.get('acodec') not in (None, 'none'))
                and f.get('acodec') not in (None, 'none')
            ]
            if http_audio:
                http_audio.sort(key=lambda f: f.get('abr') or f.get('tbr') or 0, reverse=True)
                stream_url = http_audio[0].get('url')
                logger.info(f"Selected non-HLS audio format: {http_audio[0].get('format_id')} @ {http_audio[0].get('abr')}kbps")

        if not stream_url:
            # Fallback: use yt-dlp's selected format (may be HLS)
            stream_url = info.get('url')

        if stream_url:
            # Cache for 1 hour (CDN URLs typically expire in ~4-6 hours)
            self._stream_url_cache[url] = (stream_url, now + 3600)

        return stream_url




    
    # Simple in-memory cache for resolved stream URLs (to speed up seeking)
    _stream_url_cache = {}  # {url: (stream_url, expire_time)}
    
    def __init__(self):
        # Enable redirect following and increase timeout
        # Using a shared client with a connection pool to avoid socket exhaustion
        limits = httpx.Limits(max_keepalive_connections=50, max_connections=100)
        self.client = httpx.AsyncClient(
            timeout=60.0, 
            follow_redirects=True, 
            limits=limits,
            headers={"User-Agent": USER_AGENT}
        )
        
        self.tidal_token: Optional[str] = None
        self.working_api: Optional[str] = None  # Cache the last working API
        self._token_lock = asyncio.Lock()

    async def get_tidal_token(self) -> str:
        """Get Tidal access token (serialized to prevent concurrent refresh races)."""
        async with self._token_lock:
            if self.tidal_token:
                return self.tidal_token

            response = await self.client.post(
                "https://auth.tidal.com/v1/oauth2/token",
                data={
                    "client_id": self.TIDAL_CLIENT_ID,
                    "grant_type": "client_credentials"
                },
                auth=(self.TIDAL_CLIENT_ID, self.TIDAL_CLIENT_SECRET)
            )
            response.raise_for_status()
            self.tidal_token = response.json()["access_token"]
            return self.tidal_token
    
    async def search_tidal_by_isrc(self, isrc: str, query: str = "") -> Optional[Dict[str, Any]]:
        """Search Tidal for a track by ISRC."""
        try:
            token = await self.get_tidal_token()
            search_query = query or isrc
            
            response = await self.client.get(
                "https://api.tidal.com/v1/search/tracks",
                headers={"Authorization": f"Bearer {token}"},
                params={
                    "query": search_query,
                    "limit": 25,
                    "offset": 0,
                    "countryCode": "US"
                }
            )
            
            # If token expired, invalidate and retry once
            if response.status_code == 401:
                logger.warning("Tidal token expired (401), refreshing...")
                self.tidal_token = None
                token = await self.get_tidal_token()
                response = await self.client.get(
                    "https://api.tidal.com/v1/search/tracks",
                    headers={"Authorization": f"Bearer {token}"},
                    params={
                        "query": search_query,
                        "limit": 25,
                        "offset": 0,
                        "countryCode": "US"
                    }
                )
            
            response.raise_for_status()
            
            data = response.json()
            items = data.get("items", [])
            
            # Find by ISRC match
            for item in items:
                if item.get("isrc") == isrc:
                    return item
            
            # Fall back to first result
            return items[0] if items else None
            
        except Exception as e:
            logger.error(f"Tidal search error: {e}")
            return None
    
    async def get_tidal_download_url_from_api(self, api_url: str, track_id: int, quality: str = "LOSSLESS") -> Optional[dict]:
        """Resolve a playable FLAC source from a single Tidal hifi-api instance.

        Returns a structured dict describing how to obtain the audio, or None:
          {"kind": "url",  "url": "https://...flac"}            — direct/signed FLAC file (BTS manifest or legacy)
          {"kind": "dash", "manifest": "<MPD xml>",             — MPEG-DASH manifest; caller must remux via ffmpeg
                           "bit_depth": 16, "sample_rate": 44100}

        Modern hifi-api (v2.x) returns Tidal's base64 manifest. For LOSSLESS/HI_RES
        the manifest is usually MPEG-DASH XML (fMP4 FLAC segments); occasionally a
        BTS-JSON manifest with a single direct URL. Dead-token instances answer 403.
        """
        import base64
        import json as json_module

        try:
            full_url = f"{api_url}/track/?id={track_id}&quality={quality}"
            logger.debug(f"Trying API: {api_url} (quality={quality})")

            response = await self.client.get(full_url, timeout=30.0)

            if response.status_code != 200:
                # 403 "Upstream API error" = this instance's Tidal token is dead
                logger.warning(f"Tidal proxy {api_url} returned {response.status_code} (quality={quality})")
                return None

            content_type = response.headers.get("content-type", "")
            if "html" in content_type.lower():
                logger.warning(f"Tidal proxy {api_url} returned HTML instead of JSON")
                return None

            try:
                data = response.json()
            except Exception:
                logger.warning(f"Tidal proxy {api_url} returned invalid JSON")
                return None

            # --- hifi-api v2.x format: {"version": ..., "data": {...}} ---
            if isinstance(data, dict) and "data" in data and isinstance(data["data"], dict):
                inner = data["data"]
                manifest_b64 = inner.get("manifest")
                manifest_mime = (inner.get("manifestMimeType") or "").lower()
                bit_depth = inner.get("bitDepth")
                sample_rate = inner.get("sampleRate")

                if not manifest_b64:
                    logger.debug(f"{api_url}: no manifest field for quality={quality}")
                    return None

                try:
                    decoded = base64.b64decode(manifest_b64).decode("utf-8", errors="replace")
                except Exception as e:
                    logger.debug(f"{api_url}: manifest base64 decode failed: {e}")
                    return None

                if not decoded.strip():
                    logger.debug(f"{api_url}: empty manifest for quality={quality}")
                    return None

                # DASH manifest (fMP4 FLAC segments) — needs ffmpeg remux
                if "dash" in manifest_mime or decoded.lstrip().startswith("<?xml") or "<MPD" in decoded:
                    logger.info(f"Got DASH FLAC manifest from {api_url} (quality={quality}, {bit_depth}bit/{sample_rate}Hz)")
                    self.working_api = api_url
                    return {"kind": "dash", "manifest": decoded,
                            "bit_depth": bit_depth, "sample_rate": sample_rate}

                # BTS-JSON manifest — direct signed FLAC URL
                try:
                    manifest = json_module.loads(decoded)
                    urls = manifest.get("urls", [])
                    if urls:
                        logger.info(f"Got direct FLAC URL from {api_url} (BTS manifest, quality={quality})")
                        self.working_api = api_url
                        return {"kind": "url", "url": urls[0]}
                except Exception:
                    pass

                logger.debug(f"{api_url}: manifest present but no usable URL/DASH (quality={quality})")
                return None

            # --- Legacy formats (list / dict with direct URL) ---
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and item.get("OriginalTrackUrl"):
                        self.working_api = api_url
                        return {"kind": "url", "url": item["OriginalTrackUrl"]}
            elif isinstance(data, dict):
                if data.get("OriginalTrackUrl"):
                    self.working_api = api_url
                    return {"kind": "url", "url": data["OriginalTrackUrl"]}
                if data.get("url"):
                    self.working_api = api_url
                    return {"kind": "url", "url": data["url"]}

            logger.debug(f"Tidal proxy {api_url} returned unexpected format for quality={quality}")
            return None

        except httpx.TimeoutException:
            logger.warning(f"Tidal proxy {api_url} timed out")
            return None
        except Exception as e:
            logger.warning(f"Tidal proxy {api_url} error: {e}")
            return None
    
    async def update_tidal_apis(self):
        """Refresh the live Tidal instance pool from TIDAL_UPTIME_FEED.

        The feed (geeked.wtf) reports which hifi-api instances are currently up,
        split into "streaming" (can return a manifest) and "api" (search only) and
        "down". We promote streaming-capable instances to the front of TIDAL_APIS so
        racing hits a working stream source first. Falls back silently to the
        hardcoded list if the feed is unreachable. Refreshes at most every 15 min.
        """
        global TIDAL_APIS
        import time as _time

        now = _time.time()
        last = getattr(self, "_apis_updated_at", 0)
        if now - last < 900:  # 15 min cache
            return
        self._apis_updated_at = now

        try:
            resp = await self.client.get(TIDAL_UPTIME_FEED, timeout=8.0)
            if resp.status_code != 200:
                return
            data = resp.json()

            def _urls(category):
                out = []
                for e in data.get(category, []) or []:
                    if isinstance(e, dict) and e.get("url"):
                        out.append(e["url"].rstrip("/"))
                return out

            streaming = _urls("streaming")   # can actually return a manifest
            api_up = _urls("api")            # up, but maybe search-only
            down = set(_urls("down"))

            if not streaming and not api_up:
                return

            # Order: live streaming instances first, then live api instances, then
            # any hardcoded entries not flagged down (as a last resort).
            ordered = []
            for u in streaming + api_up:
                if u not in ordered:
                    ordered.append(u)
            for u in TIDAL_APIS:
                if u.rstrip("/") not in ordered and u.rstrip("/") not in down:
                    ordered.append(u.rstrip("/"))

            if ordered:
                TIDAL_APIS = ordered
                logger.info(f"Tidal pool refreshed from uptime feed: "
                            f"{len(streaming)} streaming, {len(api_up)} api, {len(down)} down. "
                            f"Top: {ordered[:3]}")
        except Exception as e:
            logger.debug(f"Tidal uptime feed refresh skipped: {e}")

    def embed_metadata(self, audio_data: bytes, format: str, metadata: Dict) -> bytes:
        """Embed metadata into audio file (MP3/FLAC/ALAC/WAV)."""
        if not metadata: return audio_data
        
        logger.info(f"Embedding metadata for {format}:")
        logger.info(f"  Title: {metadata.get('title')}")
        logger.info(f"  Artist: {metadata.get('artists')}")
        
        try:
            # Determine suffix and tagging logic
            is_flac = format in ["flac", "flac_24"]
            is_mp3 = format in ["mp3", "mp3_128"]
            is_alac = format == "alac"
            is_wav = format in ["wav", "wav_24"]
            is_aiff = format in ["aiff", "aiff_24"]
            
            suffix = ".bin"
            if is_flac: suffix = ".flac"
            elif is_mp3: suffix = ".mp3"
            elif is_alac: suffix = ".m4a"
            elif is_wav: suffix = ".wav"
            elif is_aiff: suffix = ".aiff"
            
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp_path = tmp.name
                tmp.write(audio_data)
            
            # --- FLAC (16/24 bit) ---
            if is_flac:
                audio = FLAC(tmp_path)
                audio.clear_pictures()
                
                if metadata.get("title"): audio["TITLE"] = metadata["title"]
                if metadata.get("artists"): audio["ARTIST"] = metadata["artists"]
                if metadata.get("album"): audio["ALBUM"] = metadata["album"]
                if metadata.get("year"): audio["DATE"] = str(metadata["year"])[:4]
                if metadata.get("track_number"):
                     track_num = str(metadata["track_number"])
                     if metadata.get("total_tracks"):
                         track_num = f"{metadata['track_number']}/{metadata['total_tracks']}"
                     audio["TRACKNUMBER"] = track_num
                if metadata.get("total_tracks"):
                    audio["TRACKTOTAL"] = str(metadata["total_tracks"])
                    audio["TOTALTRACKS"] = str(metadata["total_tracks"]) # Compatibility
                
                if metadata.get("album_art_data"):
                    picture = Picture()
                    picture.data = metadata["album_art_data"]
                    picture.type = 3
                    picture.mime = "image/jpeg"
                    audio.add_picture(picture)
                audio.save()

            # --- MP3 (ID3) ---
            elif is_mp3:
                try:
                    audio = MP3(tmp_path, ID3=ID3)
                except:
                    audio = MP3(tmp_path)
                    audio.add_tags()
                
                if metadata.get("title"): audio.tags.add(TIT2(encoding=3, text=metadata["title"]))
                if metadata.get("artists"): audio.tags.add(TPE1(encoding=3, text=metadata["artists"]))
                if metadata.get("album"): audio.tags.add(TALB(encoding=3, text=metadata["album"]))
                if metadata.get("year"): audio.tags.add(TDRC(encoding=3, text=str(metadata["year"])[:4]))
                if metadata.get("track_number"): audio.tags.add(TRCK(encoding=3, text=str(metadata["track_number"])))
                
                if metadata.get("album_art_data"):
                    audio.tags.add(APIC(
                        encoding=3,
                        mime='image/jpeg',
                        type=3,
                        desc='Cover',
                        data=metadata["album_art_data"]
                    ))
                audio.save()
            
            # --- ALAC (M4A) ---
            elif is_alac:
                try:
                    audio = MP4(tmp_path)
                    if metadata.get("title"): audio["\xa9nam"] = metadata["title"]
                    if metadata.get("artists"): audio["\xa9ART"] = metadata["artists"]
                    if metadata.get("album"): audio["\xa9alb"] = metadata["album"]
                    if metadata.get("year"): audio["\xa9day"] = str(metadata["year"])[:4]
                    if metadata.get("track_number"):
                        # trkn is tuple of (track_num, total)
                        t_num = int(metadata.get("track_number", 0))
                        t_tot = int(metadata.get("total_tracks", 0))
                        audio["trkn"] = [(t_num, t_tot)]
                    
                    if metadata.get("album_art_data"):
                        audio["covr"] = [MP4Cover(metadata["album_art_data"], imageformat=MP4Cover.FORMAT_JPEG)]
                    audio.save()
                except Exception as e:
                    logger.error(f"ALAC tagging error: {e}")

            # Read back tagged data
            with open(tmp_path, 'rb') as f:
                tagged_data = f.read()
            
            os.remove(tmp_path)
            return tagged_data
            
        except Exception as e:
            logger.error(f"Metadata tagging error: {e}")
            if 'tmp_path' in locals() and os.path.exists(tmp_path): os.remove(tmp_path)
            return audio_data

    async def get_tidal_download_url(self, track_id: int, quality: str = "LOSSLESS") -> Optional[dict]:
        """Resolve a FLAC source from the Tidal proxy pool with parallel racing.

        Races the top PROXY_RACE_COUNT proxies in parallel and takes the first
        successful result. Falls back to remaining proxies sequentially if all
        raced proxies fail.

        Returns a structured dict (see get_tidal_download_url_from_api):
          {"kind": "url", "url": ...} or {"kind": "dash", "manifest": ..., ...}
        """
        
        # Update APIs list (only on first call, cached after that)
        await self.update_tidal_apis()
        
        # Build API list with the last working API first
        apis_to_try = list(TIDAL_APIS)
        if self.working_api and self.working_api in apis_to_try:
            apis_to_try.remove(self.working_api)
            apis_to_try.insert(0, self.working_api)
        
        # --- Phase 1: Race the top N proxies in parallel ---
        race_apis = apis_to_try[:PROXY_RACE_COUNT]
        remaining_apis = apis_to_try[PROXY_RACE_COUNT:]
        
        async def _try_api(api_url):
            """Wrapper that returns (url, result) or (url, None)."""
            try:
                result = await asyncio.wait_for(
                    self.get_tidal_download_url_from_api(api_url, track_id, quality),
                    timeout=PROXY_RACE_TIMEOUT
                )
                return result
            except asyncio.TimeoutError:
                logger.warning(f"API {api_url} timed out during race ({PROXY_RACE_TIMEOUT}s)")
                return None
            except Exception as e:
                logger.warning(f"API {api_url} error during race: {e}")
                return None
        
        if race_apis:
            logger.info(f"Racing {len(race_apis)} Tidal proxies in parallel for track {track_id} (quality={quality})")
            results = await asyncio.gather(*[_try_api(api) for api in race_apis])
            
            for i, result in enumerate(results):
                if result:
                    logger.info(f"Parallel race won by: {race_apis[i]}")
                    return result
        
        # --- Phase 2: Sequential fallback for remaining proxies ---
        for api_url in remaining_apis:
            download_url = await self.get_tidal_download_url_from_api(api_url, track_id, quality)
            if download_url:
                return download_url
        
        logger.error(f"All Tidal APIs failed for track {track_id} (quality={quality})")
        return None

    def _remux_dash_to_flac_sync(self, manifest_xml: str) -> Optional[bytes]:
        """Remux a Tidal MPEG-DASH manifest into a single FLAC file (lossless, no re-encode).

        The DASH manifest references fMP4 FLAC segments by absolute, signed HTTPS URLs.
        ffmpeg fetches every segment and concatenates them, then `-c:a copy` rewrites
        the result as a plain .flac container — bit-perfect, no quality loss.

        Runs synchronously (blocking); call via run_in_executor. Returns FLAC bytes or None.
        """
        mpd_path = None
        out_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".mpd", delete=False, mode="w", encoding="utf-8") as mpd:
                mpd.write(manifest_xml)
                mpd_path = mpd.name
            out_path = mpd_path + ".flac"

            cmd = [
                FFMPEG_PATH,
                "-y",
                "-loglevel", "error",
                # DASH segments are fetched over HTTPS; whitelist the protocols ffmpeg needs
                "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
                "-i", mpd_path,
                "-c:a", "copy",     # bit-perfect: no re-encoding
                "-f", "flac",
                out_path,
            ]
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            _, stderr = process.communicate(timeout=180)

            if process.returncode != 0:
                logger.error(f"DASH->FLAC remux failed: {stderr.decode('utf-8', errors='ignore')[:400]}")
                return None

            if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
                logger.error("DASH->FLAC remux produced no output")
                return None

            with open(out_path, "rb") as f:
                data = f.read()

            # Sanity check: must be a real FLAC stream, not a 30s preview / error page
            if data[:4] != b"fLaC":
                logger.error(f"DASH->FLAC remux output is not FLAC (magic={data[:4]!r})")
                return None

            logger.info(f"DASH->FLAC remux OK: {len(data)/1024/1024:.2f} MB")
            return data
        except subprocess.TimeoutExpired:
            logger.error("DASH->FLAC remux timed out (180s)")
            return None
        except FileNotFoundError:
            logger.error("FFmpeg not found — cannot remux DASH FLAC")
            return None
        except Exception as e:
            logger.error(f"DASH->FLAC remux error: {e}")
            return None
        finally:
            for p in (mpd_path, out_path):
                if p and os.path.exists(p):
                    try:
                        os.unlink(p)
                    except Exception:
                        pass

    def _parse_dash_segments(self, manifest_xml: str) -> Optional[tuple]:
        """Parse a Tidal SegmentTemplate DASH manifest into (init_url, [media_urls]).

        Returns None if the manifest isn't the expected single-Representation
        SegmentTemplate+SegmentTimeline shape (caller then falls back to ffmpeg).
        """
        try:
            init_m = re.search(r'initialization="([^"]+)"', manifest_xml)
            media_m = re.search(r'media="([^"]+)"', manifest_xml)
            if not init_m or not media_m:
                return None
            init_url = init_m.group(1)
            media_tmpl = media_m.group(1)

            start_m = re.search(r'startNumber="(\d+)"', manifest_xml)
            start_number = int(start_m.group(1)) if start_m else 1

            # Count segments from the SegmentTimeline: each <S> contributes (1 + r)
            seg_count = 0
            for s in re.finditer(r'<S\b[^>]*\bd="\d+"[^>]*/?>', manifest_xml):
                r_m = re.search(r'\br="(\d+)"', s.group(0))
                seg_count += 1 + (int(r_m.group(1)) if r_m else 0)
            if seg_count <= 0:
                return None

            media_urls = [
                media_tmpl.replace("$Number$", str(n))
                for n in range(start_number, start_number + seg_count)
            ]
            return init_url, media_urls
        except Exception as e:
            logger.debug(f"DASH manifest parse failed: {e}")
            return None

    def _pipe_remux_to_flac_sync(self, fmp4_data: bytes) -> Optional[bytes]:
        """Remux a concatenated fMP4 (FLAC) byte stream to .flac via ffmpeg stdin pipe."""
        out_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".flac", delete=False) as t:
                out_path = t.name
            cmd = [FFMPEG_PATH, "-y", "-loglevel", "error",
                   "-i", "pipe:0", "-c:a", "copy", "-f", "flac", out_path]
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            _, stderr = proc.communicate(input=fmp4_data, timeout=180)
            if proc.returncode != 0:
                logger.error(f"pipe remux failed: {stderr.decode('utf-8', errors='ignore')[:400]}")
                return None
            if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
                return None
            with open(out_path, "rb") as f:
                data = f.read()
            if data[:4] != b"fLaC":
                logger.error(f"pipe remux output not FLAC (magic={data[:4]!r})")
                return None
            return data
        except subprocess.TimeoutExpired:
            logger.error("pipe remux timed out (180s)")
            return None
        except Exception as e:
            logger.error(f"pipe remux error: {e}")
            return None
        finally:
            if out_path and os.path.exists(out_path):
                try:
                    os.unlink(out_path)
                except Exception:
                    pass

    async def remux_dash_to_flac(self, manifest_xml: str) -> Optional[bytes]:
        """Remux a Tidal DASH manifest into FLAC bytes (lossless, no re-encode).

        Fast path: parse the SegmentTemplate, download init + all media segments
        concurrently, concatenate, and pipe to ffmpeg. This avoids ffmpeg's slow
        sequential per-segment HTTPS fetch (which can take 10s+ on long tracks).
        Falls back to letting ffmpeg read the .mpd directly if parsing fails.
        """
        parsed = self._parse_dash_segments(manifest_xml)
        if parsed:
            init_url, media_urls = parsed
            try:
                sem = asyncio.Semaphore(16)

                async def fetch(idx, url):
                    async with sem:
                        r = await self.client.get(url, timeout=30.0)
                        r.raise_for_status()
                        return idx, r.content

                # init segment is index -1 so it sorts first
                tasks = [fetch(-1, init_url)] + [fetch(i, u) for i, u in enumerate(media_urls)]
                results = await asyncio.gather(*tasks)
                results.sort(key=lambda x: x[0])
                blob = b"".join(chunk for _, chunk in results)
                logger.info(f"DASH fetched {len(media_urls)} segments concurrently ({len(blob)/1024/1024:.1f} MB), remuxing")

                loop = asyncio.get_event_loop()
                data = await loop.run_in_executor(None, self._pipe_remux_to_flac_sync, blob)
                if data:
                    logger.info(f"DASH->FLAC (fast path) OK: {len(data)/1024/1024:.2f} MB")
                    return data
                logger.warning("Fast-path pipe remux failed; falling back to ffmpeg manifest fetch")
            except Exception as e:
                logger.warning(f"Concurrent DASH fetch failed ({e}); falling back to ffmpeg manifest fetch")

        # Fallback: let ffmpeg fetch segments itself from the .mpd
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._remux_dash_to_flac_sync, manifest_xml)

    async def _fetch_tidal_cover(self, cover_uuid: str) -> Optional[bytes]:
        """Fetch Tidal album art (cached)."""
        url = f"https://resources.tidal.com/images/{cover_uuid.replace('-', '/')}/1280x1280.jpg"
        return await self._cached_fetch_art(url)

    # album_id -> 'YYYY' release year, to avoid refetching per track of the same album
    _album_year_cache: dict = {}

    async def _get_tidal_album_year(self, album_id) -> str:
        """Look up an album's release year from the Tidal album endpoint (cached)."""
        if not album_id:
            return ""
        if album_id in self._album_year_cache:
            return self._album_year_cache[album_id]
        year = ""
        try:
            token = await self.get_tidal_token()
            r = await self.client.get(
                f"https://api.tidal.com/v1/albums/{album_id}",
                headers={"Authorization": f"Bearer {token}"},
                params={"countryCode": "US"},
                timeout=8.0,
            )
            if r.status_code == 200:
                rd = (r.json().get("releaseDate") or "")[:4]
                if rd.isdigit():
                    year = rd
        except Exception as e:
            logger.debug(f"Tidal album year lookup failed for {album_id}: {e}")
        # Cache even empty results to avoid repeat lookups (bounded)
        if len(self._album_year_cache) < 500:
            self._album_year_cache[album_id] = year
        return year

    async def get_deezer_track_info(self, isrc: str) -> Optional[Dict]:
        """Get Deezer track info from ISRC."""
        try:
            response = await self.client.get(
                f"https://api.deezer.com/2.0/track/isrc:{isrc}"
            )
            if response.status_code == 200:
                data = response.json()
                if "error" not in data:
                    return data
            return None
        except Exception as e:
            logger.error(f"Deezer lookup error: {e}")
            return None
    
    async def get_deezer_download_url(self, track_id: int) -> Optional[str]:
        """Get FLAC download URL from Deezer API."""
        try:
            response = await self.client.get(
                f"{DEEZER_API_URL}/dl/{track_id}",
                timeout=30.0
            )
            
            if response.status_code != 200:
                logger.warning(f"Deezer API returned {response.status_code}")
                return None
            
            data = response.json()
            if data.get("success"):
                return data.get("links", {}).get("flac")
            
            return None
            
        except Exception as e:
            logger.error(f"Deezer download URL error: {e}")
            return None

    async def fetch_tidal_metadata(self, track: Dict) -> Dict:
        """Extract metadata from Tidal track object."""
        try:
            album = track.get("album", {})
            artist = track.get("artist", {})
            if not artist and track.get("artists"):
                artist = track.get("artists")[0]
                
            cover_uuid = album.get("cover")
            album_art_data = None
            if cover_uuid:
                 album_art_data = await self._fetch_tidal_cover(cover_uuid)
                 
            return {
                "title": track.get("title"),
                "artist": artist.get("name"),
                "artists": artist.get("name"), # For embed_metadata
                "album": album.get("title"),
                "year": track.get("releaseDate", "")[:4],
                "track_number": track.get("trackNumber"),
                "album_art_data": album_art_data,
                "album_art_url": None
            }
        except Exception as e:
            logger.error(f"Metadata extraction error: {e}")
            return {}
    
    async def fetch_flac(self, isrc: str, query: str = "", hires: bool = True, hires_quality: str = "7", source: str = "") -> Optional[Union[tuple[bytes, Dict], tuple[str, Dict]]]:
        """Fetch FLAC audio and metadata with optimized search pipeline.

        # ============================================================
        # STREAM FETCH PRIORITY CHAIN (v4 — lossless only, no YouTube)
        # ============================================================
        #
        # Hi-Res OFF (HiFi only):
        #   1. Tidal LOSSLESS (16-bit FLAC) — DASH manifest remuxed via ffmpeg
        #   2. Qobuz quality 6 (16-bit FLAC CD quality) — if its proxies recover
        #
        # Hi-Res ON:
        #   1. Tidal HI_RES_LOSSLESS (24-bit FLAC)
        #   2. Tidal LOSSLESS fallback (16-bit)
        #   3. Qobuz Hi-Res (quality 7=24-bit/96kHz or 27=24-bit/192kHz)
        #
        # Tidal streaming is served by the hifi-api proxy pool. The live instance
        # (currently hifi.binimum.org) returns a base64 MPEG-DASH manifest of fMP4
        # FLAC segments; we remux it to a single .flac with ffmpeg (-c:a copy, lossless).
        # Qobuz quality codes: 27=24-bit/192k, 7=24-bit/96k, 6=16-bit CD, 5=MP3.
        #
        # NOTE: No lossy/YouTube fallback by design — this app streams lossless only.
        # ============================================================
        """

        deezer_info = None

        # --- Direct Qobuz routing: qobuz_ prefixed IDs skip search ---
        if isrc.startswith("qobuz_"):
            logger.info(f"Qobuz track ID detected — streaming directly")
            from app.qobuz_service import qobuz_service
            qobuz_quality = hires_quality if hires else "6"
            qobuz_id = isrc.replace("qobuz_", "")
            stream_url = await qobuz_service.get_stream_url(qobuz_id, quality=qobuz_quality)
            if stream_url:
                meta = {"title": query or "Unknown", "artists": "", "album": "", "is_hi_res": hires}
                return (stream_url, meta)
            logger.error(f"Qobuz direct stream failed for: {isrc}")
            return None

        # --- Pre-processing: Normalize ISRC / extract real ISRC from Deezer IDs ---
        if isrc.startswith("dz_"):
            deezer_track_id = isrc.replace("dz_", "")
            logger.info(f"Deezer track ID detected: {deezer_track_id}")
            try:
                response = await self.client.get(f"https://api.deezer.com/track/{deezer_track_id}")
                if response.status_code == 200:
                    deezer_info = response.json()
                    if "error" not in deezer_info:
                        extracted_isrc = deezer_info.get("isrc")
                        if extracted_isrc:
                            logger.info(f"Extracted ISRC from Deezer: {extracted_isrc}")
                            isrc = extracted_isrc
                            query = query or f"{deezer_info.get('title', '')} {deezer_info.get('artist', {}).get('name', '')}"
                        else:
                            query = query or f"{deezer_info.get('title', '')} {deezer_info.get('artist', {}).get('name', '')}"
                            logger.warning("No ISRC in Deezer track — will search by query")
            except Exception as e:
                logger.error(f"Deezer track info fetch error: {e}")

        if isrc.startswith("query:"):
            query = isrc.replace("query:", "")
            isrc = ""
            logger.info(f"ListenBrainz track — searching by query: {query}")

        # ============================================================
        # PATH SELECTION
        # ============================================================

        if not hires:
            # ========== FAST PATH: Hi-Res OFF ==========
            logger.info(f"[FAST PATH] Hi-Res OFF — Tidal LOSSLESS first, Qobuz fallback")

            # Step 1: Tidal LOSSLESS (16-bit)
            result = await self._fetch_from_tidal(isrc, query, quality="LOSSLESS", is_hires=False)
            if result:
                return result

            # Step 2: Qobuz 16-bit FLAC (only if its proxies are reachable)
            if ENABLE_QOBUZ:
                logger.info("[FAST PATH] Tidal failed, trying Qobuz 16-bit")
                result = await self._fetch_from_qobuz(query or isrc, "6")
                if result:
                    return result

            logger.error(f"[FAST PATH] Could not fetch lossless audio for: {isrc or query}")
            return None

        else:
            # ========== HI-RES PATH: Hi-Res ON ==========
            logger.info(f"[HI-RES PATH] Hi-Res ON — trying Tidal HI_RES_LOSSLESS first")

            # Step 1: Tidal HI_RES_LOSSLESS (24-bit, parallel racing)
            result = await self._fetch_from_tidal(isrc, query, quality="HI_RES_LOSSLESS", is_hires=True)
            if result:
                return result

            # Step 2: Tidal LOSSLESS fallback (16-bit)
            logger.info("[HI-RES PATH] HI_RES_LOSSLESS failed, falling back to Tidal LOSSLESS (16-bit)")
            result = await self._fetch_from_tidal(isrc, query, quality="LOSSLESS", is_hires=False)
            if result:
                return result

            # Step 3: Qobuz Hi-Res
            if ENABLE_QOBUZ:
                logger.info("[HI-RES PATH] Tidal failed, trying Qobuz Hi-Res")
                result = await self._fetch_from_qobuz(query or isrc, hires_quality)
                if result:
                    return result

            # Step 4: Dab Music (if separately enabled)
            if ENABLE_DAB and source != "tidal":
                result = await self._fetch_from_dab(isrc, query, hires_quality)
                if result:
                    return result

            logger.error(f"[HI-RES PATH] Could not fetch lossless audio for: {isrc or query}")
            return None
    
    # ============================================================
    # PRIVATE HELPERS — One per source, clean and isolated
    # ============================================================
    
    async def _fetch_from_tidal(self, isrc: str, query: str, quality: str = "LOSSLESS", is_hires: bool = False) -> Optional[tuple]:
        """Fetch lossless audio from the Tidal hifi-api proxy pool.

        Returns either:
          (stream_url, meta)  — direct/signed FLAC URL (BTS manifest); main.py proxies it
          (flac_bytes, meta)  — DASH manifest remuxed to a complete FLAC file
        """
        try:
            tidal_track = await self.search_tidal_by_isrc(isrc, query)
            if not tidal_track:
                logger.warning(f"Tidal search returned no results for: {isrc or query}")
                return None

            track_id = tidal_track.get("id")
            resolved = await self.get_tidal_download_url(track_id, quality=quality)

            if not resolved:
                logger.warning(f"Tidal proxy returned no source for track {track_id} (quality={quality})")
                return None

            # Resolve the album's real release year. Tidal's *search* result omits the
            # album release date, so look it up from the album endpoint (cached per album)
            # — this populates both the FLAC year tag and the library "Album (Year)" folder.
            album_obj = tidal_track.get("album", {}) or {}
            year = album_obj.get("releaseDate") or ""
            if not year:
                year = await self._get_tidal_album_year(album_obj.get("id"))

            # Build metadata (album art is embedded for the DASH/bytes path)
            meta = {
                "title": tidal_track.get("title"),
                "artists": ", ".join([a["name"] for a in tidal_track.get("artists", [])]),
                "album": album_obj.get("title"),
                "year": year,
                "track_number": tidal_track.get("trackNumber"),
                "is_hi_res": is_hires,
            }

            kind = resolved.get("kind")

            # --- DASH manifest: remux fMP4 FLAC segments into one FLAC file ---
            if kind == "dash":
                bit_depth = resolved.get("bit_depth")
                # Trust the manifest's reported bit depth for the Hi-Res badge
                if bit_depth and int(bit_depth) >= 24:
                    meta["is_hi_res"] = True
                elif bit_depth:
                    meta["is_hi_res"] = False

                logger.info(f"✓ Tidal DASH manifest for track {track_id} (quality={quality}, {bit_depth}bit) — remuxing")
                flac_bytes = await self.remux_dash_to_flac(resolved["manifest"])
                if not flac_bytes:
                    logger.warning(f"DASH remux failed for track {track_id}")
                    return None

                # Embed tags + album art into the remuxed FLAC
                cover_uuid = tidal_track.get("album", {}).get("cover")
                if cover_uuid:
                    meta["album_art_data"] = await self._fetch_tidal_cover(cover_uuid)
                try:
                    flac_bytes = await asyncio.get_event_loop().run_in_executor(
                        None, self.embed_metadata, flac_bytes, "flac", meta
                    )
                except Exception as e:
                    logger.debug(f"FLAC tag embed skipped: {e}")

                return (flac_bytes, meta)

            # --- Direct/signed URL (BTS manifest or legacy) ---
            download_url = resolved.get("url")
            if not download_url:
                return None
            logger.info(f"✓ Tidal direct FLAC URL (quality={quality}): {download_url[:80]}...")

            cover_uuid = tidal_track.get("album", {}).get("cover")
            if cover_uuid:
                meta["album_art_data"] = await self._fetch_tidal_cover(cover_uuid)

            return (download_url, meta)
        except Exception as e:
            logger.error(f"Tidal fetch error: {e}")
            return None
    
    async def _fetch_from_qobuz(self, query: str, hires_quality: str) -> Optional[tuple]:
        """Try to fetch a stream URL from Qobuz via multiple proxy endpoints."""
        try:
            from app.qobuz_service import qobuz_service

            if not query:
                return None

            qobuz_track = None
            is_isrc = query and len(query) == 12 and query[:2].isalpha() and query[2:].isalnum()
            if is_isrc:
                qobuz_track = await qobuz_service.search_by_isrc(query)

            if not qobuz_track:
                qobuz_tracks = await qobuz_service.search_tracks(query, limit=1)
                if not qobuz_tracks:
                    return None
                qobuz_track = qobuz_tracks[0]

            logger.info(f"Qobuz search hit: {qobuz_track.get('name')} by {qobuz_track.get('artists')}")

            qobuz_id = qobuz_track.get('id', '').replace('qobuz_', '')
            stream_url = await qobuz_service.get_stream_url(qobuz_id, quality=hires_quality)

            if not stream_url:
                return None

            logger.info(f"Qobuz stream URL found (quality={hires_quality}): {stream_url[:60]}...")
            metadata = {
                "title": qobuz_track.get("name"),
                "artists": qobuz_track.get("artists"),
                "album": qobuz_track.get("album"),
                "year": qobuz_track.get("release_date", "")[:4] if qobuz_track.get("release_date") else "",
                "album_art_url": qobuz_track.get("album_art"),
                "album_art_data": None,
                "is_hi_res": hires_quality in ("7", "27"),
            }
            return (stream_url, metadata)
        except Exception as e:
            logger.error(f"Qobuz fetch error: {e}")
            return None
    
    async def _fetch_from_ytmusic(self, query: str) -> Optional[tuple]:
        """Last-resort fallback: search YouTube Music and extract audio via yt-dlp."""
        try:
            from app.ytmusic_service import ytmusic_service
            results = await ytmusic_service.search_tracks(query, limit=1)
            if not results:
                return None

            track = results[0]
            video_id = track.get("video_id") or track.get("id", "").replace("ytm_", "")
            if not video_id:
                return None

            logger.info(f"YouTube Music fallback: {track.get('name')} by {track.get('artists')} (vid={video_id})")
            youtube_url = f"https://music.youtube.com/watch?v={video_id}"
            loop = asyncio.get_event_loop()
            stream_url = await loop.run_in_executor(None, self._get_stream_url, youtube_url)

            if not stream_url:
                return None

            metadata = {
                "title": track.get("name"),
                "artists": track.get("artists"),
                "album": track.get("album"),
                "album_art_url": track.get("album_art"),
                "album_art_data": None,
                "is_hi_res": False,
            }
            return (stream_url, metadata)
        except Exception as e:
            logger.error(f"YouTube Music fallback error: {e}")
            return None

    async def _fetch_from_dab(self, isrc: str, query: str, hires_quality: str) -> Optional[tuple]:
        """Try to fetch a stream URL from Dab Music (currently bypassed)."""
        try:
            from app.dab_service import dab_service
            
            dab_id = None
            dab_track = None
            
            if isrc.startswith("dab_"):
                dab_id = isrc
                dab_track = await dab_service.get_track(dab_id)
            else:
                dab_query = query or (f"isrc:{isrc}" if isrc and not isrc.startswith("dz_") else "")
                if dab_query:
                    dab_tracks = await dab_service.search_tracks(dab_query, limit=1)
                    if dab_tracks:
                        dab_track = dab_tracks[0]
                        dab_id = dab_track.get('id')
            
            if not dab_id:
                return None
            
            stream_url = await dab_service.get_stream_url(dab_id, quality=hires_quality)
            if not stream_url:
                return None
            
            logger.info(f"✓ Dab stream URL found: {stream_url[:40]}...")
            
            if dab_track:
                metadata = {
                    "title": dab_track.get("name"),
                    "artists": dab_track.get("artists") if not isinstance(dab_track.get("artists"), dict) else dab_track["artists"].get("name", ""),
                    "album": dab_track.get("album") if not isinstance(dab_track.get("album"), dict) else dab_track["album"].get("title", ""),
                    "year": dab_track.get("release_date", "")[:4] if dab_track.get("release_date") else "",
                    "album_art_url": dab_track.get("album_art"),
                    "album_art_data": None,
                    "is_hi_res": True
                }
            else:
                metadata = {"title": query or "Unknown", "artists": "", "album": "", "year": "", "is_hi_res": True}
            
            return (stream_url, metadata)
        except Exception as e:
            logger.error(f"Dab Music fetch error: {e}")
            return None
    
    async def _fetch_from_deezer(self, isrc: str, query: str, deezer_info: dict = None) -> Optional[tuple]:
        """Try to fetch a stream URL from Deezer (always-available fallback)."""
        try:
            # Resolve Deezer track info if not already cached
            if not deezer_info and isrc.startswith("dz_"):
                deezer_track_id = isrc.replace("dz_", "")
                try:
                    response = await self.client.get(f"https://api.deezer.com/track/{deezer_track_id}")
                    if response.status_code == 200:
                        deezer_info = response.json()
                except:
                    pass
            elif not deezer_info and isrc:
                deezer_info = await self.get_deezer_track_info(isrc)
            elif not deezer_info and query:
                try:
                    response = await self.client.get(
                        "https://api.deezer.com/search/track",
                        params={"q": query, "limit": 1}
                    )
                    if response.status_code == 200:
                        data = response.json()
                        tracks = data.get("data", [])
                        if tracks:
                            deezer_info = tracks[0]
                            logger.info(f"Deezer search found: {deezer_info.get('title')} by {deezer_info.get('artist', {}).get('name')}")
                except Exception as e:
                    logger.error(f"Deezer search error: {e}")
            
            if not deezer_info or "error" in deezer_info:
                return None
            
            deezer_id = deezer_info.get("id")
            download_url = await self.get_deezer_download_url(deezer_id)
            
            if not download_url:
                return None
            
            logger.info(f"✓ Deezer stream found: {download_url[:60]}...")
            
            artists_list = [a["name"] for a in deezer_info.get("contributors", [])] if deezer_info.get("contributors") else [deezer_info.get("artist", {}).get("name")]
            meta = {
                "title": deezer_info.get("title"),
                "artists": ", ".join(filter(None, artists_list)),
                "album": deezer_info.get("album", {}).get("title"),
                "year": deezer_info.get("release_date"),
                "track_number": deezer_info.get("track_position"),
            }
            
            # Fetch album art (needed for download metadata embedding)
            cover_url = deezer_info.get("album", {}).get("cover_xl")
            if cover_url:
                art_data = await self._cached_fetch_art(cover_url)
                if art_data:
                    meta["album_art_data"] = art_data
            
            return (download_url, meta)
        except Exception as e:
            logger.error(f"Deezer fetch error: {e}")
            return None
    
    def transcode_to_mp3(self, flac_data: bytes, bitrate: str = BITRATE) -> Optional[bytes]:
        """Transcode FLAC to MP3 using FFmpeg."""
        try:
            # Use FFmpeg with stdin/stdout for streaming
            process = subprocess.Popen(
                [
                    FFMPEG_PATH,
                    "-i", "pipe:0",          # Read from stdin
                    "-vn",                    # No video
                    "-acodec", "libmp3lame",  # MP3 encoder
                    "-b:a", bitrate,          # Bitrate
                    "-f", "mp3",              # Output format
                    "pipe:1"                  # Write to stdout
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            mp3_data, stderr = process.communicate(input=flac_data)
            
            if process.returncode != 0:
                logger.error(f"FFmpeg error: {stderr.decode()[:500]}")
                return None
            
            logger.info(f"Transcoded to MP3: {len(mp3_data) / 1024 / 1024:.2f} MB")
            return mp3_data
            
        except FileNotFoundError:
            logger.error("FFmpeg not found! Please install FFmpeg.")
            return None
        except Exception as e:
            logger.error(f"Transcode error: {e}")
            return None
    
    async def get_audio_stream(self, isrc: str, query: str = "") -> Optional[bytes]:
        """Get transcoded MP3 audio, using cache if available."""
        
        # Check cache first
        if is_cached(isrc, "mp3"):
            logger.info(f"Cache hit for {isrc}")
            cached_data = await get_cached_file(isrc, "mp3")
            if cached_data:
                return cached_data
                

        
        # Fetch and transcode
        logger.info(f"Cache miss for {isrc}, fetching...")
        result = await self.fetch_flac(isrc, query)
        
        if not result:
            return None
            
        flac_data, metadata = result
        
        # Transcode (run in executor to not block)
        loop = asyncio.get_event_loop()
        mp3_data = await loop.run_in_executor(None, self.transcode_to_mp3, flac_data)
        
        if mp3_data:
            # Cache the result
            await cache_file(isrc, mp3_data, "mp3")
        
        return mp3_data
    


    # Format configurations for FFmpeg
    FORMAT_CONFIG = {
        "mp3": {
            "ext": ".mp3",
            "mime": "audio/mpeg",
            "args": ["-acodec", "libmp3lame", "-b:a", "320k", "-f", "mp3"]
        },
        "mp3_128": {
            "ext": ".mp3",
            "mime": "audio/mpeg", 
            "args": ["-acodec", "libmp3lame", "-b:a", "128k", "-f", "mp3"]
        },
        "flac": {
            "ext": ".flac",
            "mime": "audio/flac",
            "args": ["-acodec", "flac", "-sample_fmt", "s16", "-f", "flac"]  # Force 16-bit
        },
        "flac_24": {
            "ext": ".flac",
            "mime": "audio/flac",
            "args": ["-acodec", "flac", "-sample_fmt", "s32", "-f", "flac"]  # 24-bit preserved
        },
        "aiff": {
            "ext": ".aiff",
            "mime": "audio/aiff",
            "args": ["-acodec", "pcm_s16be", "-f", "aiff"]
        },
        "wav": {
            "ext": ".wav",
            "mime": "audio/wav",
            "args": ["-acodec", "pcm_s16le", "-f", "wav"]
        },
        "wav_24": {
            "ext": ".wav",
            "mime": "audio/wav",
            "args": ["-acodec", "pcm_s24le", "-f", "wav"]
        },
        "alac": {
            "ext": ".m4a",
            "mime": "audio/mp4",
            "args": ["-acodec", "alac", "-f", "ipod"]
        },
        "aiff_24": {
            "ext": ".aiff",
            "mime": "audio/aiff",
            "args": ["-acodec", "pcm_s24be", "-f", "aiff"]
        }
    }
    
    def transcode_to_format(self, flac_data: bytes, format: str = "mp3") -> Optional[bytes]:
        """Transcode FLAC to specified format using FFmpeg."""
        config = self.FORMAT_CONFIG.get(format, self.FORMAT_CONFIG["mp3"])
        
        # Use temporary file for output to ensure proper header/duration writing (especially for FLAC)
        # FFmpeg cannot update FLAC header duration when writing to pipe
        import tempfile
        import os
        
        with tempfile.NamedTemporaryFile(suffix=config["ext"], delete=False) as tmp_out:
            output_path = tmp_out.name
        
        try:
            logger.info(f"Transcoding to {format} using FFmpeg at: {FFMPEG_PATH}")

            cmd = [
                FFMPEG_PATH,
                "-i", "pipe:0",      # Read from stdin
                "-vn",               # No video
                "-y"                 # Overwrite output file
            ] + config["args"] + [
                output_path          # Write to file
            ]
            
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            _, stderr = process.communicate(input=flac_data)
            
            if process.returncode != 0:
                logger.error(f"FFmpeg error: {stderr.decode('utf-8', errors='ignore')[:500]}")
                if os.path.exists(output_path): os.unlink(output_path)
                return None
            
            if os.path.exists(output_path):
                size_mb = os.path.getsize(output_path) / 1024 / 1024
                logger.info(f"Transcoded to {config['ext']}: {size_mb:.2f} MB")
                
                with open(output_path, "rb") as f:
                    output_data = f.read()
                return output_data
            else:
                logger.error("Transcoding failed: Output file not created")
                return None
            
        except FileNotFoundError:
            logger.error("FFmpeg not found! Please install FFmpeg.")
            return None
        except Exception as e:
            logger.error(f"Transcode error: {e}")
            return None
        finally:
            if os.path.exists(output_path):
                try:
                    os.unlink(output_path)
                except: pass
            

    
    async def get_download_audio(self, isrc: str, query: str, format: str = "mp3", track_number: Optional[int] = None, provided_metadata: Optional[Dict] = None, hires: bool = False, hires_quality: str = "6") -> Optional[tuple]:
        """Get audio in specified format for download. Returns (data, extension, mime_type)."""
        
        config = self.FORMAT_CONFIG.get(format, self.FORMAT_CONFIG["mp3"])
        cache_ext = format if format != "mp3_128" else "mp3_128"
        
        # Skip cache for downloads to ensure we get fresh metadata
        # if is_cached(isrc, cache_ext):
        #    ...
        
        # Fetch FLAC
        logger.info(f"Fetching audio for download (skipping cache to ensure tags): {isrc}")
        
        # Handle Imported Links
        if isrc.startswith("LINK:"):
             # ... (existing link handling)
             return None # Todo: handle link tagging similarly if possible
        
        result = await self.fetch_flac(isrc, query, hires=hires, hires_quality=hires_quality)
        
        if not result:
            return None
            
        flac_data, metadata = result
        
        # If flac_data is a URL string (from Dab service), download the actual audio
        if isinstance(flac_data, str) and flac_data.startswith("http"):
            logger.info(f"Downloading audio from stream URL for batch download...")
            try:
                response = await self.client.get(flac_data, timeout=180.0)
                if response.status_code == 200:
                    flac_data = response.content
                    logger.info(f"Downloaded {len(flac_data) / 1024 / 1024:.2f} MB from stream URL")
                else:
                    logger.error(f"Failed to download from stream URL: HTTP {response.status_code}")
                    return None
            except Exception as e:
                logger.error(f"Stream URL download error: {e}")
                return None
        
        # Use provided_metadata from frontend if available (overrides fetched metadata)
        if provided_metadata:
            logger.info(f"Using provided metadata from frontend")
            # Override empty/missing fields with provided metadata
            if not metadata.get("title") or metadata.get("title") == query:
                metadata["title"] = provided_metadata.get("title") or metadata.get("title")
            if not metadata.get("artists"):
                metadata["artists"] = provided_metadata.get("artists") or metadata.get("artists")
            if not metadata.get("album"):
                metadata["album"] = provided_metadata.get("album") or metadata.get("album")
            if not metadata.get("year"):
                metadata["year"] = provided_metadata.get("year") or metadata.get("year")
            # Download album art from provided URL if we don't have art data
            if not metadata.get("album_art_data") and provided_metadata.get("album_art_url"):
                try:
                    art_data = await self._cached_fetch_art(provided_metadata["album_art_url"])
                    if art_data:
                        metadata["album_art_data"] = art_data
                        logger.info("Downloaded album art from provided URL")
                except Exception as e:
                    logger.debug(f"Failed to download provided album art: {e}")
        
        # Add track number if provided
        if track_number is not None:
            metadata["track_number"] = track_number
            logger.info(f"Setting track number: {track_number}")
        
        # Add total tracks from provided_metadata if available
        if provided_metadata and provided_metadata.get("total_tracks"):
            metadata["total_tracks"] = provided_metadata["total_tracks"]
        
        # Enrich metadata with MusicBrainz only when fields are missing
        needs_enrichment = (
            not metadata.get("year") or
            not metadata.get("album") or
            not metadata.get("album_art_data")
        )
        if needs_enrichment:
            try:
                from app.musicbrainz_service import musicbrainz_service
                mb_data = await musicbrainz_service.lookup_by_isrc(isrc)

                # Fallback to query if no result by ISRC (common for dab_ ids)
                if not mb_data and (not metadata.get("year") or not metadata.get("album_art_data")):
                    mb_data = await musicbrainz_service.lookup_by_query(metadata.get("title"), metadata.get("artists"))

                if mb_data:
                    # Fill in missing fields from MusicBrainz
                    if not metadata.get("album") and mb_data.get("album"):
                        metadata["album"] = mb_data["album"]
                    if not metadata.get("year") and mb_data.get("release_date"):
                        metadata["year"] = mb_data["release_date"]
                    if mb_data.get("label"):
                        metadata["label"] = mb_data["label"]
                    # Use MusicBrainz cover art if we don't have one
                    if not metadata.get("album_art_data") and mb_data.get("cover_art_url"):
                        art_data = await self._cached_fetch_art(mb_data["cover_art_url"])
                        if art_data:
                            metadata["album_art_data"] = art_data
                            logger.info("Using cover art from Cover Art Archive")
            except Exception as e:
                logger.debug(f"MusicBrainz enrichment skipped: {e}")
        
        # Transcode/Passthrough
        loop = asyncio.get_event_loop()
        
        # FLAC Bypass: If source is already FLAC and requested format is FLAC,
        # skip the pointless re-encode through FFmpeg
        is_flac_source = isinstance(flac_data, bytes) and len(flac_data) >= 4 and flac_data[:4] == b'fLaC'
        is_flac_target = format in ("flac", "flac_24")
        
        if is_flac_source and is_flac_target:
            logger.info(f"FLAC bypass: source is already FLAC, skipping transcode")
            output_data = flac_data
        else:
            output_data = await loop.run_in_executor(
                None, self.transcode_to_format, flac_data, format
            )
        
        if output_data:
            # Embed Metadata
            tag_format = format if not (is_flac_source and is_flac_target) else "flac"
            output_data = await loop.run_in_executor(
                None, self.embed_metadata, output_data, tag_format, metadata
            )
            
            return (output_data, config["ext"], config["mime"])
        
        return None
    
    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()
        # Close Dab Service
        try:
            from app.dab_service import dab_service
            await dab_service.close()
        except: pass


# Singleton instance
audio_service = AudioService()
