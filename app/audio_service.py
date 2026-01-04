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
from typing import Optional, Dict, Any, List
import logging
import json
import tempfile
from urllib.parse import urlparse
import re

from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TRCK, TDRC, TCON, APIC, COMM
from mutagen.mp3 import MP3, EasyMP3
from mutagen.mp4 import MP4, MP4Cover

from fastapi.responses import StreamingResponse, FileResponse
from fastapi import Request, HTTPException
from starlette.background import BackgroundTask

from app.cache import is_cached, get_cached_file, cache_file, get_cache_path

logger = logging.getLogger(__name__)

# Configuration
BITRATE = os.environ.get("MP3_BITRATE", "320k")
DEEZER_API_URL = os.environ.get("DEEZER_API_URL", "https://api.deezmate.com")

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

# List of Tidal API endpoints with fallback (fastest/most reliable first)
# This will be updated dynamically
TIDAL_APIS = [
    "https://triton.squid.wtf",  # From Monochrome - fast primary
    "https://hifi.401658.xyz",
    "https://tidal.kinoplus.online",
    "https://tidal-api.binimum.org",
    "https://wolf.qqdl.site",
    "https://maus.qqdl.site",
    "https://vogel.qqdl.site",
    "https://katze.qqdl.site",
    "https://hund.qqdl.site",
]



class AudioService:
    """Service for fetching and transcoding audio."""
    
    # Tidal credentials (same as SpotiFLAC)
    TIDAL_CLIENT_ID = base64.b64decode("NkJEU1JkcEs5aHFFQlRnVQ==").decode()
    TIDAL_CLIENT_SECRET = base64.b64decode("eGV1UG1ZN25icFo5SUliTEFjUTkzc2hrYTFWTmhlVUFxTjZJY3N6alRHOD0=").decode()

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
        
        # Use yt-dlp for page URLs (YouTube, Bandcamp, etc.)
        info = self._extract_info_safe(url)
        if not info: return None
        if 'entries' in info: info = info['entries'][0]
        return info.get('url')

    def transcode_url_to_mp3(self, stream_url: str, bitrate: str = BITRATE) -> Optional[bytes]:
        """Transcode a direct stream URL to MP3."""
        try:
            logger.info(f"Transcoding URL to MP3: {stream_url[:50]}...")
            process = subprocess.Popen(
                [
                    FFMPEG_PATH,
                    "-i", stream_url,
                    "-vn",
                    "-acodec", "libmp3lame",
                    "-b:a", bitrate,
                    "-f", "mp3",
                    "pipe:1"
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            mp3_data, stderr = process.communicate()
            
            if process.returncode != 0:
                logger.error(f"FFmpeg URL transcode error: {stderr.decode()[:500]}")
                return None
            return mp3_data
        except Exception as e:
            logger.error(f"URL transcode error: {e}")
            return None

    async def get_audio_from_url(self, url: str) -> Optional[bytes]:
        """Get MP3 audio from a URL using yt-dlp (for YouTube, YTMusic, etc.).
        Returns transcoded MP3 bytes or None on failure.
        """
        try:
            logger.info(f"Fetching audio from URL via yt-dlp: {url[:60]}...")
            
            # Extract best audio stream URL using yt-dlp
            stream_url = self._get_stream_url(url)
            if not stream_url:
                logger.error(f"Could not extract stream URL from: {url}")
                return None
            
            logger.info(f"Got stream URL, transcoding to MP3...")
            
            # Transcode to MP3
            mp3_data = self.transcode_url_to_mp3(stream_url)
            return mp3_data
            
        except Exception as e:
            logger.error(f"get_audio_from_url error: {e}")
            return None
    
    def __init__(self):
        # Enable redirect following and increase timeout
        self.client = httpx.AsyncClient(timeout=120.0, follow_redirects=True)
        self.tidal_token: Optional[str] = None
        self.working_api: Optional[str] = None  # Cache the last working API
    
    async def get_tidal_token(self) -> str:
        """Get Tidal access token."""
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
    
    async def get_tidal_download_url_from_api(self, api_url: str, track_id: int, quality: str = "LOSSLESS") -> Optional[str]:
        """Get download URL from a specific Tidal API."""
        import base64
        import json as json_module
        
        try:
            full_url = f"{api_url}/track/?id={track_id}&quality={quality}"
            logger.info(f"Trying API: {api_url}")
            
            response = await self.client.get(full_url, timeout=30.0)
            
            if response.status_code != 200:
                logger.warning(f"API {api_url} returned {response.status_code}")
                return None
            
            # Check if we got HTML instead of JSON
            content_type = response.headers.get("content-type", "")
            if "html" in content_type.lower():
                logger.warning(f"API {api_url} returned HTML instead of JSON")
                return None
            
            try:
                data = response.json()
            except Exception:
                logger.warning(f"API {api_url} returned invalid JSON")
                return None
            
            # Handle API v2.0 format with manifest
            if isinstance(data, dict) and "version" in data and "data" in data:
                inner_data = data.get("data", {})
                manifest_b64 = inner_data.get("manifest")
                
                if manifest_b64:
                    try:
                        manifest_json = base64.b64decode(manifest_b64).decode('utf-8')
                        manifest = json_module.loads(manifest_json)
                        urls = manifest.get("urls", [])
                        
                        if urls:
                            download_url = urls[0]
                            logger.info(f"Got download URL from {api_url} (v2.0 manifest)")
                            self.working_api = api_url
                            return download_url
                    except Exception as e:
                        logger.warning(f"Failed to decode manifest from {api_url}: {e}")
            
            # Handle legacy format (list with OriginalTrackUrl)
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and "OriginalTrackUrl" in item:
                        logger.info(f"Got download URL from {api_url} (legacy format)")
                        self.working_api = api_url
                        return item["OriginalTrackUrl"]
            
            # Handle other dict formats
            elif isinstance(data, dict):
                if "OriginalTrackUrl" in data:
                    self.working_api = api_url
                    return data["OriginalTrackUrl"]
                if "url" in data:
                    self.working_api = api_url
                    return data["url"]
            
            logger.warning(f"API {api_url} returned unexpected format")
            return None
            
        except httpx.TimeoutException:
            logger.warning(f"API {api_url} timed out")
            return None
        except Exception as e:
            logger.warning(f"API {api_url} error: {e}")
            return None
    
    async def update_tidal_apis(self):
        """Update available Tidal APIs from status server."""
        try:
            # Only update once per session to avoid delay
            if hasattr(self, '_apis_updated') and self._apis_updated:
                return

            logger.info("Updating Tidal API list...")
            async with httpx.AsyncClient(timeout=5.0) as client:
                async with client.stream("GET", "https://status.monochrome.tf/api/stream") as response:
                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            data = json.loads(line[6:])
                            
                            api_instances = [
                                inst for inst in data.get('instances', [])
                                if inst.get('instance_type') == 'api' and inst.get('last_check', {}).get('success')
                            ]
                            
                            # Sort by avg_response_time
                            api_instances.sort(key=lambda x: x.get('avg_response_time', 9999))
                            
                            new_apis = [api['url'] for api in api_instances if api.get('url')]
                            
                            if new_apis:
                                global TIDAL_APIS
                                TIDAL_APIS = new_apis
                                self._apis_updated = True
                                logger.info(f"Updated Tidal API list with {len(new_apis)} servers")
                            break # Found data, done
        except Exception as e:
            logger.warning(f"Failed to update Tidal APIs: {e}")

    def embed_metadata(self, audio_data: bytes, format: str, metadata: Dict) -> bytes:
        """Embed metadata into audio file (MP3/FLAC)."""
        if not metadata: return audio_data
        
        logger.info(f"Embedding metadata for {format}: {metadata.get('title')} - {metadata.get('year')}")
        
        try:
            suffix = ".flac" if format == "flac" else ".mp3"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_data)
                tmp_path = tmp.name
            
            if format == "flac":
                audio = FLAC(tmp_path)
                audio.clear_pictures()
                
                if metadata.get("title"): audio["TITLE"] = metadata["title"]
                if metadata.get("artists"): audio["ARTIST"] = metadata["artists"]
                if metadata.get("album"): audio["ALBUM"] = metadata["album"]
                if metadata.get("year"): audio["DATE"] = str(metadata["year"])[:4]
                if metadata.get("track_number"): audio["TRACKNUMBER"] = str(metadata["track_number"])
                
                if metadata.get("album_art_data"):
                    picture = Picture()
                    picture.data = metadata["album_art_data"]
                    picture.type = PictureType.COVER_FRONT
                    picture.mime = "image/jpeg"
                    audio.add_picture(picture)
                audio.save()

            elif format in ["mp3", "mp3_128"]:
                try:
                    audio = MP3(tmp_path, ID3=ID3)
                except:
                    audio = MP3(tmp_path)
                    audio.add_tags()
                
                # ID3 Tags
                if metadata.get("title"): audio.tags.add(TIT2(encoding=3, text=metadata["title"]))
                if metadata.get("artists"): audio.tags.add(TPE1(encoding=3, text=metadata["artists"]))
                if metadata.get("album"): audio.tags.add(TALB(encoding=3, text=metadata["album"]))
                if metadata.get("year"): audio.tags.add(TDRC(encoding=3, text=str(metadata["year"])[:4]))
                if metadata.get("track_number"): audio.tags.add(TRCK(encoding=3, text=str(metadata["track_number"])))
                
                if metadata.get("album_art_data"):
                    audio.tags.add(
                        APIC(
                            encoding=3,
                            mime='image/jpeg',
                            type=3,
                            desc='Cover',
                            data=metadata["album_art_data"]
                        )
                    )
                audio.save()

            with open(tmp_path, 'rb') as f:
                tagged_data = f.read()
            
            os.remove(tmp_path)
            return tagged_data
            
        except Exception as e:
            logger.error(f"Metadata tagging error: {e}")
            if os.path.exists(tmp_path): os.remove(tmp_path)
            return audio_data

    async def get_tidal_download_url(self, track_id: int, quality: str = "LOSSLESS") -> Optional[str]:
        """Get download URL from Tidal APIs with fallback."""
        
        # Update APIs first
        await self.update_tidal_apis()
        
        # Build API list with the last working API first
        apis_to_try = list(TIDAL_APIS)
        if self.working_api and self.working_api in apis_to_try:
            apis_to_try.remove(self.working_api)
            apis_to_try.insert(0, self.working_api)
        
        # Try each API until one works
        for api_url in apis_to_try:
            download_url = await self.get_tidal_download_url_from_api(api_url, track_id, quality)
            if download_url:
                return download_url
        
        logger.error("All Tidal APIs failed")
        return None
    
    async def _fetch_tidal_cover(self, cover_uuid: str) -> Optional[bytes]:
        """Fetch Tidal album art."""
        try:
            url = f"https://resources.tidal.com/images/{cover_uuid.replace('-', '/')}/1280x1280.jpg"
            response = await self.client.get(url)
            if response.status_code == 200:
                return response.content
        except Exception:
            pass
        return None

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
    
    async def fetch_flac(self, isrc: str, query: str = "") -> Optional[tuple[bytes, Dict]]:
        """Fetch FLAC audio and metadata from Tidal or Deezer (with fallback)."""
        
        # Handle Deezer track IDs directly (dz_XXXXX format)
        if isrc.startswith("dz_"):
            deezer_track_id = isrc.replace("dz_", "")
            logger.info(f"Deezer track ID detected: {deezer_track_id}")
            
            try:
                # Fetch track info directly by Deezer ID
                response = await self.client.get(
                    f"https://api.deezer.com/track/{deezer_track_id}"
                )
                if response.status_code == 200:
                    deezer_info = response.json()
                    if "error" not in deezer_info:
                        download_url = await self.get_deezer_download_url(int(deezer_track_id))
                        
                        if download_url:
                            logger.info(f"Downloading from Deezer (direct ID)...")
                            dl_response = await self.client.get(download_url, timeout=180.0)
                            if dl_response.status_code == 200:
                                logger.info(f"Downloaded {len(dl_response.content) / 1024 / 1024:.2f} MB from Deezer")
                                
                                meta = {
                                    "title": deezer_info.get("title"),
                                    "artists": [a["name"] for a in deezer_info.get("contributors", [])] or [deezer_info.get("artist", {}).get("name")],
                                    "album": deezer_info.get("album", {}).get("title"),
                                    "year": deezer_info.get("release_date"),
                                    "track_number": deezer_info.get("track_position"),
                                }
                                cover_url = deezer_info.get("album", {}).get("cover_xl")
                                if cover_url:
                                    try:
                                        cover_resp = await self.client.get(cover_url)
                                        if cover_resp.status_code == 200:
                                            meta["album_art_data"] = cover_resp.content
                                    except: pass
                                
                                return (dl_response.content, meta)
            except Exception as e:
                logger.error(f"Deezer direct ID fetch error: {e}")
            
            logger.error(f"Could not fetch audio for Deezer ID: {isrc}")
            return None
        
        # Try Tidal first for regular ISRCs
        logger.info(f"Trying Tidal for ISRC: {isrc}")
        tidal_track = await self.search_tidal_by_isrc(isrc, query)
        
        if tidal_track:
            track_id = tidal_track.get("id")
            download_url = await self.get_tidal_download_url(track_id)
            
            if download_url:
                logger.info(f"Downloading from Tidal: {download_url[:80]}...")
                try:
                    response = await self.client.get(download_url, timeout=180.0)
                    if response.status_code == 200:
                        content_type = response.headers.get("content-type", "")
                        size_mb = len(response.content) / 1024 / 1024
                        logger.info(f"Downloaded {size_mb:.2f} MB from Tidal")
                        
                        # Extract Metadata
                        meta = {
                            "title": tidal_track.get("title"),
                            "artists": [a["name"] for a in tidal_track.get("artists", [])],
                            "album": tidal_track.get("album", {}).get("title"),
                            "year": tidal_track.get("album", {}).get("releaseDate"),
                            "track_number": tidal_track.get("trackNumber"),
                        }
                        cover_uuid = tidal_track.get("album", {}).get("cover")
                        if cover_uuid:
                            meta["album_art_data"] = await self._fetch_tidal_cover(cover_uuid)
                            
                        return (response.content, meta)
                    else:
                        logger.warning(f"Download failed with status {response.status_code}")
                except Exception as e:
                    logger.error(f"Tidal download error: {e}")
        
        # Fallback to Deezer
        logger.info(f"Trying Deezer for ISRC: {isrc}")
        deezer_info = await self.get_deezer_track_info(isrc)
        
        if deezer_info:
            deezer_id = deezer_info.get("id")
            download_url = await self.get_deezer_download_url(deezer_id)
            
            if download_url:
                logger.info(f"Downloading from Deezer...")
                try:
                    response = await self.client.get(download_url, timeout=180.0)
                    if response.status_code == 200:
                        logger.info(f"Downloaded {len(response.content) / 1024 / 1024:.2f} MB from Deezer")
                        
                        # Extract Metadata
                        meta = {
                            "title": deezer_info.get("title"),
                            "artists": [a["name"] for a in deezer_info.get("contributors", [])] or [deezer_info.get("artist", {}).get("name")],
                            "album": deezer_info.get("album", {}).get("title"),
                            "year": deezer_info.get("release_date"),
                            "track_number": deezer_info.get("track_position"),
                        }
                        cover_url = deezer_info.get("album", {}).get("cover_xl")
                        if cover_url:
                            try:
                                cover_resp = await self.client.get(cover_url)
                                if cover_resp.status_code == 200:
                                    meta["album_art_data"] = cover_resp.content
                            except: pass

                        return (response.content, meta)
                except Exception as e:
                    logger.error(f"Deezer download error: {e}")
        
        logger.error(f"Could not fetch audio for ISRC: {isrc}")
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
                
        # Handle Imported Links
        if isrc.startswith("LINK:"):
            try:
                encoded_url = isrc.replace("LINK:", "")
                original_url = base64.urlsafe_b64decode(encoded_url).decode()
                
                logger.info(f"Processing imported link: {original_url}")
                loop = asyncio.get_event_loop()
                
                # Get stream URL
                stream_url = await loop.run_in_executor(None, self._get_stream_url, original_url)
                if not stream_url: return None
                
                # Transcode
                mp3_data = await loop.run_in_executor(None, self.transcode_url_to_mp3, stream_url)
                
                if mp3_data:
                    await cache_file(isrc, mp3_data, "mp3")
                    return mp3_data
                return None
            except Exception as e:
                logger.error(f"Link handling error: {e}")
                return None
        
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
    
    async def handle_link_stream(self, request: Request, isrc: str):
        """Handle streaming for LINK: prefixed IDs."""
        try:
            encoded_url = isrc.replace("LINK:", "")
            original_url = base64.urlsafe_b64decode(encoded_url).decode()

            # Check if it's a direct audio file
            parsed = urlparse(original_url)
            audio_extensions = ('.mp3', '.m4a', '.ogg', '.wav', '.aac', '.opus')
            if any(parsed.path.lower().endswith(ext) for ext in audio_extensions):
                logger.info(f"Proxying direct audio URL (with seeking support): {original_url[:60]}...")

                # Prepare headers to forward (especially Range)
                req_headers = {}
                if request.headers.get("Range"):
                    req_headers["Range"] = request.headers.get("Range")
                    logger.info(f"Forwarding Range header: {req_headers['Range']}")

                client = httpx.AsyncClient(follow_redirects=True, timeout=60.0)
                req = client.build_request("GET", original_url, headers=req_headers)
                r = await client.send(req, stream=True)

                # Determine content type
                ext = parsed.path.lower().split('.')[-1]
                content_types = {
                    'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'ogg': 'audio/ogg',
                    'wav': 'audio/wav', 'aac': 'audio/aac', 'opus': 'audio/opus'
                }
                content_type = r.headers.get("Content-Type") or content_types.get(ext, 'audio/mpeg')

                # Prepare response headers
                resp_headers = {
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "public, max-age=3600"
                }
                if r.headers.get("Content-Range"):
                    resp_headers["Content-Range"] = r.headers.get("Content-Range")
                if r.headers.get("Content-Length"):
                    resp_headers["Content-Length"] = r.headers.get("Content-Length")

                return StreamingResponse(
                    r.aiter_bytes(chunk_size=65536),
                    status_code=r.status_code,
                    media_type=content_type,
                    headers=resp_headers,
                    background=BackgroundTask(client.aclose)
                )

            # Not a direct link, fall back to transcoding stream
            return StreamingResponse(
                self.stream_audio_generator(isrc),
                media_type="audio/mpeg",
                headers={"Cache-Control": "public, max-age=86400"}
            )
        except Exception as e:
            logger.warning(f"Failed to proxy LINK: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    async def handle_ytm_stream(self, isrc: str):
        """Handle streaming for YouTube Music tracks."""
        video_id = isrc.replace("ytm_", "")
        youtube_url = f"https://music.youtube.com/watch?v={video_id}"
        logger.info(f"YTMusic track detected, fetching via yt-dlp: {youtube_url}")

        # Check cache first
        if is_cached(isrc, "mp3"):
            cache_path = get_cache_path(isrc, "mp3")
            logger.info(f"Serving YTM from cache: {cache_path}")
            return FileResponse(
                cache_path,
                media_type="audio/mpeg",
                headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"}
            )

        # Get stream URL via yt-dlp
        stream_url = self._get_stream_url(youtube_url)
        if not stream_url:
            raise HTTPException(status_code=404, detail="Could not extract YouTube Music audio URL")

        logger.info(f"Proxying YTM audio directly (no transcode): {stream_url[:60]}...")

        # Proxy the stream directly - no transcoding needed
        async def proxy_ytm_stream():
            async with httpx.AsyncClient(follow_redirects=True, timeout=300.0) as client:
                async with client.stream("GET", stream_url) as response:
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        yield chunk

        # Determine content type from URL
        content_type = "audio/webm" if "webm" in stream_url else "audio/mp4"

        return StreamingResponse(
            proxy_ytm_stream(),
            media_type=content_type,
            headers={"Cache-Control": "no-cache"}
        )

    async def stream_audio_generator(self, isrc: str, query: str = ""):
        """
        Async generator that streams MP3 data as FFmpeg transcodes.
        Yields chunks incrementally for faster time-to-first-byte.
        Also caches the complete file after streaming finishes.
        """
        # Check cache first - if cached, yield entire file at once
        if is_cached(isrc, "mp3"):
            logger.info(f"Cache hit for streaming {isrc}")
            cached_data = await get_cached_file(isrc, "mp3")
            if cached_data:
                yield cached_data
                return
        
        # For imported links
        if isrc.startswith("LINK:"):
            try:
                encoded_url = isrc.replace("LINK:", "")
                original_url = base64.urlsafe_b64decode(encoded_url).decode()
                
                logger.info(f"Streaming imported link: {original_url}")
                loop = asyncio.get_event_loop()
                
                # Get stream URL
                stream_url = await loop.run_in_executor(None, self._get_stream_url, original_url)
                if not stream_url:
                    logger.error(f"Could not resolve stream URL for {isrc}")
                    raise HTTPException(status_code=404, detail="Could not resolve audio stream")
                
                # Stream transcode and yield chunks
                chunks = []
                # Use robust generator with cleanup
                generator = self._stream_transcode_url(stream_url)
                try:
                    async for chunk in generator:
                        chunks.append(chunk)
                        yield chunk
                except Exception as e:
                    logger.error(f"Error streaming link: {e}")
                    raise
                
                # Cache complete file after stream completes
                if chunks:
                    complete_data = b"".join(chunks)
                    await cache_file(isrc, complete_data, "mp3")
                return
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Streaming link error: {e}")
                raise HTTPException(status_code=500, detail="Streaming error")
        
        # Fetch FLAC first (this part still needs to complete)
        logger.info(f"Streaming transcode for {isrc}")
        result = await self.fetch_flac(isrc, query)
        
        if not result:
            logger.error(f"Could not fetch audio for {isrc}")
            raise HTTPException(status_code=404, detail="Could not fetch audio")
            
        flac_data, metadata = result
        
        # Stream transcode and yield chunks
        chunks = []
        generator = self._stream_transcode_flac(flac_data)
        try:
            async for chunk in generator:
                chunks.append(chunk)
                yield chunk
        except Exception as e:
            logger.error(f"Error streaming flac: {e}")
            raise
        
        # Cache complete file after stream completes
        if chunks:
            complete_data = b"".join(chunks)
            await cache_file(isrc, complete_data, "mp3")
    
    async def _stream_transcode_flac(self, flac_data: bytes, bitrate: str = BITRATE):
        """Stream transcode FLAC data to MP3, yielding chunks."""
        try:
            logger.info(f"Starting FFmpeg process: {FFMPEG_PATH} (Input size: {len(flac_data)} bytes)")
            process = await asyncio.create_subprocess_exec(
                FFMPEG_PATH,
                "-i", "pipe:0",
                "-vn",
                "-acodec", "libmp3lame",
                "-b:a", bitrate,
                "-f", "mp3",
                "pipe:1",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            # Write input in background task - write in chunks to avoid blocking
            async def write_input():
                try:
                    chunk_size = 1024 * 1024  # 1MB chunks for writing
                    for i in range(0, len(flac_data), chunk_size):
                        if process.stdin.is_closing():
                            break
                        process.stdin.write(flac_data[i:i+chunk_size])
                        await process.stdin.drain()
                    process.stdin.close()
                    await process.stdin.wait_closed()
                except (BrokenPipeError, ConnectionResetError):
                    # Process likely exited early (e.g. error)
                    pass
                except Exception as e:
                    logger.error(f"Error writing to FFmpeg stdin: {e}")
            
            write_task = asyncio.create_task(write_input())
            
            # Read and yield output chunks
            chunk_size = 64 * 1024  # 64KB chunks for output
            bytes_read = 0
            try:
                while True:
                    chunk = await process.stdout.read(chunk_size)
                    if not chunk:
                        break
                    bytes_read += len(chunk)
                    yield chunk
            finally:
                logger.info(f"FFmpeg streaming finished. Bytes read: {bytes_read}")

                # Check for errors if no bytes read
                if bytes_read == 0:
                     stderr = await process.stderr.read()
                     if stderr:
                         logger.error(f"FFmpeg error output: {stderr.decode()[:500]}")

                # Ensure process is cleaned up even if generator is cancelled
                if process.returncode is None:
                    try:
                        process.terminate()
                        # Give it a moment to terminate gracefully
                        try:
                            await asyncio.wait_for(process.wait(), timeout=1.0)
                        except asyncio.TimeoutError:
                            process.kill()
                    except Exception:
                        pass

                await write_task  # Ensure write completes
                await process.wait()
            
        except Exception as e:
            logger.error(f"Streaming transcode error: {e}")
            raise
    
    async def _stream_transcode_url(self, stream_url: str, bitrate: str = BITRATE):
        """Stream transcode from URL to MP3, yielding chunks."""
        try:
            logger.info(f"Starting FFmpeg process for URL: {stream_url[:50]}...")
            process = await asyncio.create_subprocess_exec(
                FFMPEG_PATH,
                "-i", stream_url,
                "-vn",
                "-acodec", "libmp3lame",
                "-b:a", bitrate,
                "-f", "mp3",
                "pipe:1",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            # Read and yield output chunks
            chunk_size = 64 * 1024  # 64KB chunks
            bytes_read = 0
            try:
                while True:
                    chunk = await process.stdout.read(chunk_size)
                    if not chunk:
                        break
                    bytes_read += len(chunk)
                    yield chunk
            finally:
                logger.info(f"FFmpeg URL streaming finished. Bytes read: {bytes_read}")

                # Check for errors if no bytes read
                if bytes_read == 0:
                     stderr = await process.stderr.read()
                     if stderr:
                         logger.error(f"FFmpeg URL error output: {stderr.decode()[:500]}")

                 # Ensure process is cleaned up even if generator is cancelled
                if process.returncode is None:
                    try:
                        process.terminate()
                        # Give it a moment to terminate gracefully
                        try:
                            await asyncio.wait_for(process.wait(), timeout=1.0)
                        except asyncio.TimeoutError:
                            process.kill()
                    except Exception:
                        pass
                await process.wait()
            
        except Exception as e:
            logger.error(f"Streaming URL transcode error: {e}")
            raise

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
            "args": ["-acodec", "flac", "-f", "flac"]
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
        "alac": {
            "ext": ".m4a",
            "mime": "audio/mp4",
            "args": ["-acodec", "alac", "-f", "ipod"]
        }
    }
    
    def transcode_to_format(self, flac_data: bytes, format: str = "mp3") -> Optional[bytes]:
        """Transcode FLAC to specified format using FFmpeg."""
        config = self.FORMAT_CONFIG.get(format, self.FORMAT_CONFIG["mp3"])
        
        try:
            logger.info(f"Transcoding to {format} using FFmpeg at: {FFMPEG_PATH}")
            if format == "flac": # Passthrough for FLAC
                 return flac_data

            cmd = [
                FFMPEG_PATH,
                "-i", "pipe:0",      # Read from stdin
                "-vn",               # No video
            ] + config["args"] + [
                "pipe:1"             # Write to stdout
            ]
            
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            output_data, stderr = process.communicate(input=flac_data)
            
            if process.returncode != 0:
                logger.error(f"FFmpeg error: {stderr.decode()[:500]}")
                return None
            
            logger.info(f"Transcoded to {format}: {len(output_data) / 1024 / 1024:.2f} MB")
            return output_data
            
        except FileNotFoundError:
            logger.error("FFmpeg not found! Please install FFmpeg.")
            return None
        except Exception as e:
            logger.error(f"Transcode error: {e}")
            return None
    
    async def get_download_audio(self, isrc: str, query: str, format: str = "mp3") -> Optional[tuple]:
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
        
        result = await self.fetch_flac(isrc, query)
        
        if not result:
            return None
            
        flac_data, metadata = result
        
        # Enrich metadata with MusicBrainz (release year, label, better cover art)
        try:
            from app.musicbrainz_service import musicbrainz_service
            mb_data = await musicbrainz_service.lookup_by_isrc(isrc)
            if mb_data:
                # Fill in missing fields from MusicBrainz
                if not metadata.get("year") and mb_data.get("release_date"):
                    metadata["year"] = mb_data["release_date"]
                if mb_data.get("label"):
                    metadata["label"] = mb_data["label"]
                # Use MusicBrainz cover art if we don't have one
                if not metadata.get("album_art_data") and mb_data.get("cover_art_url"):
                    try:
                        cover_resp = await self.client.get(mb_data["cover_art_url"])
                        if cover_resp.status_code == 200:
                            metadata["album_art_data"] = cover_resp.content
                            logger.info("Using cover art from Cover Art Archive")
                    except: pass
        except Exception as e:
            logger.debug(f"MusicBrainz enrichment skipped: {e}")
        
        # Transcode/Passthrough
        loop = asyncio.get_event_loop()
        output_data = await loop.run_in_executor(
            None, self.transcode_to_format, flac_data, format
        )
        
        if output_data:
            # Embed Metadata
            output_data = await loop.run_in_executor(
                None, self.embed_metadata, output_data, format, metadata
            )
            
            # Cache it? Maybe not since it has user-specific tags? 
            # Actually standard tags are fine.
            # await cache_file(isrc, output_data, cache_ext)
            return (output_data, config["ext"], config["mime"])
        
        return None
    
    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()


# Singleton instance
audio_service = AudioService()
