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
TIDAL_APIS = [
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
    
    async def get_tidal_download_url(self, track_id: int, quality: str = "LOSSLESS") -> Optional[str]:
        """Get download URL from Tidal APIs with fallback."""
        
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
    
    async def get_deezer_track_id(self, isrc: str) -> Optional[int]:
        """Get Deezer track ID from ISRC."""
        try:
            response = await self.client.get(
                f"https://api.deezer.com/2.0/track/isrc:{isrc}"
            )
            if response.status_code == 200:
                data = response.json()
                if "error" not in data:
                    return data.get("id")
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
    
    async def fetch_flac(self, isrc: str, query: str = "") -> Optional[bytes]:
        """Fetch FLAC audio from Tidal or Deezer (with fallback)."""
        
        # Try Tidal first
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
                        logger.info(f"Downloaded {size_mb:.2f} MB from Tidal (type: {content_type})")
                        return response.content
                    else:
                        logger.warning(f"Download failed with status {response.status_code}")
                except Exception as e:
                    logger.error(f"Tidal download error: {e}")
        
        # Fallback to Deezer
        logger.info(f"Trying Deezer for ISRC: {isrc}")
        deezer_id = await self.get_deezer_track_id(isrc)
        
        if deezer_id:
            download_url = await self.get_deezer_download_url(deezer_id)
            
            if download_url:
                logger.info(f"Downloading from Deezer...")
                try:
                    response = await self.client.get(download_url, timeout=180.0)
                    if response.status_code == 200:
                        logger.info(f"Downloaded {len(response.content) / 1024 / 1024:.2f} MB from Deezer")
                        return response.content
                except Exception as e:
                    logger.error(f"Deezer download error: {e}")
        
        logger.error(f"Could not fetch audio for ISRC: {isrc}")
        return None
    
    def transcode_to_mp3(self, flac_data: bytes, bitrate: str = BITRATE) -> Optional[bytes]:
        """Transcode FLAC to MP3 using FFmpeg."""
        try:
            logger.info(f"Using FFmpeg at: {FFMPEG_PATH}")
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
        flac_data = await self.fetch_flac(isrc, query)
        
        if not flac_data:
            return None
        
        # Transcode (run in executor to not block)
        loop = asyncio.get_event_loop()
        mp3_data = await loop.run_in_executor(None, self.transcode_to_mp3, flac_data)
        
        if mp3_data:
            # Cache the result
            await cache_file(isrc, mp3_data, "mp3")
        
        return mp3_data
    
    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()


# Singleton instance
audio_service = AudioService()
