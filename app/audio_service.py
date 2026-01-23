"""
Audio service for fetching and transcoding music.
Fetches FLAC from Tidal/Deezer and transcodes to MP3 using FFmpeg.
Uses multiple API endpoints with fallback for reliability.
"""
import os
import io
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

# List of Tidal API endpoints with fallback (ordered by reliability/weight)
TIDAL_APIS = [
    "https://triton.squid.wtf",           # Primary - squid-api (weight 30)
    "https://hifi-one.spotisaver.net",    # spotisaver cluster (weight 20)
    "https://hifi-two.spotisaver.net",    # spotisaver cluster (weight 20)
    "https://tidal.kinoplus.online",      # kinoplus (weight 20)
    "https://tidal-api.binimum.org",      # binimum (weight 10)
    "https://hund.qqdl.site",             # qqdl cluster (weight 15)
    "https://katze.qqdl.site",
    "https://maus.qqdl.site",
    "https://vogel.qqdl.site",
    "https://wolf.qqdl.site",
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
        
        # Use yt-dlp for page URLs (YouTube, Bandcamp, etc.)
        info = self._extract_info_safe(url)
        if not info: return None
        if 'entries' in info: info = info['entries'][0]
        
        stream_url = info.get('url')
        if stream_url:
            # Cache for 1 hour (Google URLs usually expire in ~4-6 hours)
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
        
        logger.info(f"Embedding metadata for {format}:")
        logger.info(f"  Title: {metadata.get('title')}")
        logger.info(f"  Artist: {metadata.get('artists')}")
        logger.info(f"  Album: {metadata.get('album')}")
        logger.info(f"  Year: {metadata.get('year')}")
        logger.info(f"  Track#: {metadata.get('track_number')}/{metadata.get('total_tracks', '?')}")
        logger.info(f"  Cover: {'Yes' if metadata.get('album_art_data') else 'No'}")
        
        try:
            suffix = ".flac" if format == "flac" else ".mp3"
            buffer = io.BytesIO(audio_data)
            
            if format == "flac":
                audio = FLAC(buffer)
                audio.clear_pictures()
                
                if metadata.get("title"): audio["TITLE"] = metadata["title"]
                if metadata.get("artists"): audio["ARTIST"] = metadata["artists"]
                if metadata.get("album"): audio["ALBUM"] = metadata["album"]
                if metadata.get("year"): audio["DATE"] = str(metadata["year"])[:4]
                # Track number with total (e.g., "3/12")
                if metadata.get("track_number"):
                    track_num = str(metadata["track_number"])
                    if metadata.get("total_tracks"):
                        track_num = f"{metadata['track_number']}/{metadata['total_tracks']}"
                    audio["TRACKNUMBER"] = track_num
                if metadata.get("total_tracks"):
                    audio["TRACKTOTAL"] = str(metadata["total_tracks"])
                    audio["TOTALTRACKS"] = str(metadata["total_tracks"])
                
                if metadata.get("album_art_data"):
                    picture = Picture()
                    picture.data = metadata["album_art_data"]
                    picture.type = 3  # 3 = COVER_FRONT picture type
                    picture.mime = "image/jpeg"
                    audio.add_picture(picture)
                buffer.seek(0)
                audio.save(buffer)

            elif format in ["mp3", "mp3_128"]:
                try:
                    audio = MP3(buffer, ID3=ID3)
                except:
                    audio = MP3(buffer)
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
                    buffer.seek(0)
                audio.save(buffer)

            buffer.seek(0)
            return buffer.read()
            
        except Exception as e:
            logger.error(f"Metadata tagging error: {e}")
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
    
    async def fetch_flac(self, isrc: str, query: str = "", hires: bool = True) -> Optional[Union[tuple[bytes, Dict], tuple[str, Dict]]]:
        """Fetch FLAC audio and metadata from Tidal or Deezer (with fallback)."""
        
        deezer_info = None  # Cache for potential metadata use
        
        # Handle Deezer track IDs (dz_XXXXX format) - extract ISRC first
        if isrc.startswith("dz_"):
            deezer_track_id = isrc.replace("dz_", "")
            logger.info(f"Deezer track ID detected: {deezer_track_id}")
            
            try:
                # Fetch track info from Deezer public API to get ISRC
                response = await self.client.get(
                    f"https://api.deezer.com/track/{deezer_track_id}"
                )
                if response.status_code == 200:
                    deezer_info = response.json()
                    if "error" not in deezer_info:
                        extracted_isrc = deezer_info.get("isrc")
                        if extracted_isrc:
                            logger.info(f"Extracted ISRC from Deezer: {extracted_isrc}")
                            isrc = extracted_isrc  # Use real ISRC for Tidal lookup
                            query = query or f"{deezer_info.get('title', '')} {deezer_info.get('artist', {}).get('name', '')}"
                        else:
                            logger.warning("No ISRC in Deezer track - will try Deezer download directly")
            except Exception as e:
                logger.error(f"Deezer track info fetch error: {e}")
        
        # Handle query: prefixed IDs (from ListenBrainz playlists)
        # These are searchable by artist + title, no ISRC available
        if isrc.startswith("query:"):
            query = isrc.replace("query:", "")
            isrc = ""  # Clear ISRC, will search by query only
            logger.info(f"ListenBrainz track - searching by query: {query}")
        
        
        # 0. Try Dab Music (Qobuz Hi-Res Proxy) - New! Priority #1
        try:
            from app.dab_service import dab_service
            
            dab_id = None
            dab_track = None  # Initialize to avoid UnboundLocalError
            
            if isrc.startswith("dab_"):
                dab_id = isrc
                # Fetch track metadata by ID
                dab_track = await dab_service.get_track(dab_id)
                if dab_track:
                    logger.info(f"Fetched Dab track metadata: {dab_track.get('name')} by {dab_track.get('artists')}")
            else:
                 # Search prioritization:
                 # Prefer standard query (Artist + Title) because ISRC support on Dab is flaky.
                 dab_query = query
                 if not dab_query and isrc and not isrc.startswith("dz_"):
                      dab_query = f"isrc:{isrc}"
                 
                 if dab_query:
                     dab_tracks = await dab_service.search_tracks(dab_query, limit=1)
                     if dab_tracks:
                         dab_track = dab_tracks[0]
                         dab_id = dab_track.get('id')
                         
                         # Optional: Verify title match if using query?
                         # For now assume top result is correct as Dab/Qobuz search is usually okay for metadata.
            
            if dab_id:
                # Select quality
                quality = "27" if hires else "7"
                stream_url = await dab_service.get_stream_url(dab_id, quality=quality)
                
                if stream_url:
                    logger.info(f"Dab Stream URL found: {stream_url[:40]}...")
                    
                    # Metadata gathering
                    # Use Dab metadata if available, otherwise fallback to query string
                    if dab_track:
                        metadata = {
                            "title": dab_track.get("name"),  # _format_track uses "name" not "title"
                            "artists": dab_track.get("artists"),  # Already correct
                            "album": dab_track.get("album"),  # _format_track uses "album" not "albumTitle"
                            "year": dab_track.get("release_date", "")[:4] if dab_track.get("release_date") else "",
                            "album_art_url": dab_track.get("album_art"),  # _format_track uses "album_art" not "albumCover"
                            "album_art_data": None
                        }
                        # Ensure artists/album are strings (should already be from _format_track)
                        if isinstance(metadata["artists"], dict): metadata["artists"] = metadata["artists"].get("name", "")
                        if isinstance(metadata["album"], dict): metadata["album"] = metadata["album"].get("title", "")
                        
                        # Download album art if URL is present
                        if metadata.get("album_art_url"):
                            try:
                                art_resp = await self.client.get(metadata["album_art_url"])
                                if art_resp.status_code == 200:
                                    metadata["album_art_data"] = art_resp.content
                                    logger.info("Downloaded album art from Dab/Qobuz")
                            except Exception as e:
                                logger.debug(f"Failed to download album art: {e}")
                    else:
                        # Fallback: extract from query string (format: "Title Artist")
                        parts = query.split(" ") if query else []
                        metadata = {
                            "title": query or "Unknown",
                            "artists": "",  # Changed from "artist" to "artists"
                            "album": "",
                            "year": "",
                            "album_art_url": None,
                            "album_art_data": None
                        }

                    metadata["is_hi_res"] = True
                    return (stream_url, metadata)
        except Exception as e:
            logger.error(f"Dab Music fetch error: {e}")

        # 1. Try Tidal (Primary Source)
        if not isrc.startswith("dz_"):  # Only if we have a real ISRC
            logger.info(f"Trying Tidal APIs for ISRC: {isrc}")
            tidal_track = await self.search_tidal_by_isrc(isrc, query)
            
            if tidal_track:
                track_id = tidal_track.get("id")
                download_url = await self.get_tidal_download_url(track_id)
                
                if download_url:
                    logger.info(f"Downloading from Tidal: {download_url[:80]}...")
                    try:
                        response = await self.client.get(download_url, timeout=180.0)
                        if response.status_code == 200:
                            size_mb = len(response.content) / 1024 / 1024
                            logger.info(f"Downloaded {size_mb:.2f} MB from Tidal")
                            
                            meta = {
                                "title": tidal_track.get("title"),
                                "artists": ", ".join([a["name"] for a in tidal_track.get("artists", [])]),  # Join to string
                                "album": tidal_track.get("album", {}).get("title"),
                                "year": tidal_track.get("album", {}).get("releaseDate"),
                                "track_number": tidal_track.get("trackNumber"),
                            }
                            cover_uuid = tidal_track.get("album", {}).get("cover")
                            if cover_uuid:
                                meta["album_art_data"] = await self._fetch_tidal_cover(cover_uuid)
                                
                            return (response.content, meta)
                    except Exception as e:
                        logger.error(f"Tidal download error: {e}")
            else:
                logger.warning(f"Tidal search returned no results for: {isrc}")
        
        # Fallback to Deezer FLAC download (deezmate API)
        logger.info(f"Falling back to Deezer for: {isrc or query}")
        
        # If we have cached deezer_info from above, use it; otherwise fetch
        if not deezer_info and isrc.startswith("dz_"):
            deezer_track_id = isrc.replace("dz_", "")
            try:
                response = await self.client.get(f"https://api.deezer.com/track/{deezer_track_id}")
                if response.status_code == 200:
                    deezer_info = response.json()
            except:
                pass
        elif not deezer_info and isrc:
            # Lookup by ISRC
            deezer_info = await self.get_deezer_track_info(isrc)
        elif not deezer_info and query:
            # No ISRC - search by query (for ListenBrainz tracks)
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
        
        if deezer_info and "error" not in deezer_info:
            deezer_id = deezer_info.get("id")
            download_url = await self.get_deezer_download_url(deezer_id)
            
            if download_url:
                logger.info(f"Downloading from Deezer (deezmate)...")
                try:
                    response = await self.client.get(download_url, timeout=180.0)
                    if response.status_code == 200:
                        logger.info(f"Downloaded {len(response.content) / 1024 / 1024:.2f} MB from Deezer")
                        
                        # Get artists as string
                        artists_list = [a["name"] for a in deezer_info.get("contributors", [])] if deezer_info.get("contributors") else [deezer_info.get("artist", {}).get("name")]
                        meta = {
                            "title": deezer_info.get("title"),
                            "artists": ", ".join(filter(None, artists_list)),  # Join to string, filter None
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
        
        logger.error(f"Could not fetch audio for: {isrc}")
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
            

    
    async def get_download_audio(self, isrc: str, query: str, format: str = "mp3", track_number: Optional[int] = None, provided_metadata: Optional[Dict] = None) -> Optional[tuple]:
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
                    art_resp = await self.client.get(provided_metadata["album_art_url"])
                    if art_resp.status_code == 200:
                        metadata["album_art_data"] = art_resp.content
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
        
        # Enrich metadata with MusicBrainz (release year, label, better cover art)
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
                    try:
                        cover_resp = await self.client.get(mb_data["cover_art_url"])
                        if cover_resp.status_code == 200:
                            metadata["album_art_data"] = cover_resp.content
                            logger.info("Using cover art from Cover Art Archive")
                        else:
                            logger.warning(f"MB cover art download failed: {cover_resp.status_code} for {mb_data['cover_art_url']}")
                    except Exception as e:
                        logger.error(f"Failed to download MB cover art: {e}")
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
        # Close Dab Service
        try:
            from app.dab_service import dab_service
            await dab_service.close()
        except: pass


# Singleton instance
audio_service = AudioService()
