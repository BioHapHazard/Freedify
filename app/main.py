"""
Freedify Streaming Server
A FastAPI server for streaming music with FFmpeg transcoding.
"""
import os
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Response, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import zipfile
import io
from typing import List


from app.deezer_service import deezer_service
from app.live_show_service import live_show_service
from app.spotify_service import spotify_service
from app.audio_service import audio_service
from app.podcast_service import podcast_service
from app.dj_service import dj_service
from app.ai_radio_service import ai_radio_service
from app.ytmusic_service import ytmusic_service
from app.setlist_service import setlist_service
from app.listenbrainz_service import listenbrainz_service
from app.cache import cleanup_cache, periodic_cleanup, is_cached, get_cache_path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    logger.info("Starting Freedify Streaming Server...")
    
    # Initial cache cleanup
    await cleanup_cache()
    
    # Start periodic cleanup task
    cleanup_task = asyncio.create_task(periodic_cleanup(30))
    
    yield
    
    # Cleanup on shutdown
    cleanup_task.cancel()
    await deezer_service.close()
    await live_show_service.close()
    await spotify_service.close()
    await audio_service.close()
    await podcast_service.close()
    logger.info("Server shutdown complete.")


app = FastAPI(
    title="Freedify Streaming",
    description="Stream music from Deezer, Spotify URLs, and Live Archives",
    lifespan=lifespan
)

# CORS for mobile access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Middleware to set COOP header for Google OAuth popups
@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    # Allow popups (like Google Sign-In) to communicate with window
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"
    return response


# ========== MODELS ==========

class ParseUrlRequest(BaseModel):
    url: str

class ImportRequest(BaseModel):
    url: str


# ========== API ENDPOINTS ==========

@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": "freedify-streaming"}


@app.get("/api/search")
async def search(
    q: str = Query(..., min_length=1, description="Search query"),
    type: str = Query("track", description="Search type: track, album, artist, or podcast"),
    offset: int = Query(0, description="Offset for pagination")
):
    """Search for tracks, albums, artists, or podcasts."""
    try:
        # Check for Spotify URL (uses Spotify API - may be rate limited)
        if spotify_service.is_spotify_url(q):
            parsed = spotify_service.parse_spotify_url(q)
            if parsed:
                url_type, item_id = parsed
                logger.info(f"Detected Spotify URL: {url_type}/{item_id}")
                try:
                    return await get_spotify_content(url_type, item_id)
                except HTTPException as e:
                    # If Spotify fails (rate limited), return error with info
                    raise HTTPException(
                        status_code=503,
                        detail=str(e.detail)
                    )
        
        # Check for other URLs (Bandcamp, Soundcloud, Phish.in, Archive.org, etc.)
        if q.startswith("http://") or q.startswith("https://"):
            logger.info(f"Detected URL: {q}")
            item = await audio_service.import_url(q)
            if item:
                # Check if it's an album/playlist
                if item.get('type') == 'album':
                    return {
                        "results": [item],
                        "type": "album",
                        "is_url": True, 
                        "source": "import",
                        "tracks": item.get('tracks', [])
                    }
                # Single track
                return {"results": [item], "type": "track", "is_url": True, "source": "import"}
        # Podcast Search
        if type == "podcast":
            results = await podcast_service.search_podcasts(q)
            return {"results": results, "query": q, "type": "podcast", "source": "podcast", "offset": offset}
        
        # YouTube Music Search
        if type == "ytmusic":
            results = await ytmusic_service.search_tracks(q, limit=20, offset=offset)
            return {"results": results, "query": q, "type": "track", "source": "ytmusic", "offset": offset}
        
        # Setlist.fm Search
        if type == "setlist":
            results = await setlist_service.search_setlists(q)
            return {"results": results, "query": q, "type": "album", "source": "setlist.fm", "offset": offset}
            
        # Check for live show searches FIRST if no type specified or type is album
        # But only if NOT one of the special types above (which returned already)
        live_results = await live_show_service.search_live_shows(q)
        if live_results is not None:
            return {"results": live_results, "query": q, "type": "album", "source": "live_shows"}
        
        # Regular search - Use Deezer (no rate limits)
        logger.info(f"Searching Deezer for: {q} (type: {type}, offset: {offset})")
        if type == "album":
            results = await deezer_service.search_albums(q, limit=20, offset=offset)
        elif type == "artist":
            results = await deezer_service.search_artists(q, limit=20, offset=offset)
        else:
            results = await deezer_service.search_tracks(q, limit=20, offset=offset)
        
        return {"results": results, "query": q, "type": type, "source": "deezer", "offset": offset}
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def get_content_by_type(content_type: str, item_id: str):
    """Helper to get content by type and ID (uses Deezer)."""
    if content_type == "track":
        results = await deezer_service.search_tracks(item_id, limit=1)
        if results:
            return {"results": results, "type": "track", "is_url": True}
    elif content_type == "album":
        album = await deezer_service.get_album(item_id)
        if album:
            return {"results": [album], "type": "album", "is_url": True, "tracks": album.get("tracks", [])}
    elif content_type == "artist":
        artist = await deezer_service.get_artist(item_id)
        if artist:
            return {"results": [artist], "type": "artist", "is_url": True, "tracks": artist.get("tracks", [])}
    
    raise HTTPException(status_code=404, detail=f"{content_type.title()} not found")


async def get_spotify_content(content_type: str, item_id: str):
    """Helper to get content from Spotify by type and ID."""
    if content_type == "track":
        track = await spotify_service.get_track_by_id(item_id)
        if track:
            return {"results": [track], "type": "track", "is_url": True, "source": "spotify"}
    elif content_type == "album":
        album = await spotify_service.get_album(item_id)
        if album:
            return {"results": [album], "type": "album", "is_url": True, "tracks": album.get("tracks", []), "source": "spotify"}
    elif content_type == "playlist":
        playlist = await spotify_service.get_playlist(item_id)
        if playlist:
            return {"results": [playlist], "type": "playlist", "is_url": True, "tracks": playlist.get("tracks", []), "source": "spotify"}
    elif content_type == "artist":
        artist = await spotify_service.get_artist(item_id)
        if artist:
            return {"results": [artist], "type": "artist", "is_url": True, "tracks": artist.get("tracks", []), "source": "spotify"}
    
    raise HTTPException(status_code=404, detail=f"Spotify {content_type.title()} not found")


@app.post("/api/import")
async def import_url_endpoint(request: ImportRequest):
    """Import a track from a URL (Bandcamp, Soundcloud, etc.)."""
    try:
        track = await audio_service.import_url(request.url)
        if not track:
            raise HTTPException(status_code=400, detail="Could not import URL")
        return track
    except Exception as e:
        logger.error(f"Import endpoint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/track/{track_id}")
async def get_track(track_id: str):
    """Get track details by Spotify ID."""
    try:
        track = await spotify_service.get_track_by_id(track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        return track
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Track fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/album/{album_id}")
async def get_album(album_id: str):
    """Get album details with all tracks."""
    try:
        # Handle different sources based on ID prefix
        if album_id.startswith("dz_"):
            # Deezer album
            album = await deezer_service.get_album(album_id)
        elif album_id.startswith("archive_"):
            # Archive.org show - import via URL
            identifier = album_id.replace("archive_", "")
            url = f"https://archive.org/details/{identifier}"
            logger.info(f"Importing Archive.org show: {url}")
            album = await audio_service.import_url(url)
        elif album_id.startswith("phish_"):
            # Phish.in show - import via URL 
            date = album_id.replace("phish_", "")
            url = f"https://phish.in/{date}"
            logger.info(f"Importing Phish.in show: {url}")
            album = await audio_service.import_url(url)
        elif album_id.startswith("pod_"):
            # Podcast Import (PodcastIndex)
            feed_id = album_id.replace("pod_", "")
            album = await podcast_service.get_podcast_episodes(feed_id)
        elif album_id.startswith("setlist_"):
            # Setlist.fm - get full setlist with tracks
            setlist_id = album_id.replace("setlist_", "")
            album = await setlist_service.get_setlist(setlist_id)
            if album and album.get("audio_source") == "phish.in":
                # Phish show - fetch audio from phish.in
                album["audio_available"] = True
            elif album and album.get("audio_source") == "archive.org":
                # Other artist - find best Archive.org version
                archive_url = await setlist_service.find_best_archive_show(
                    album.get("artists", ""),
                    album.get("iso_date", "")
                )
                if archive_url:
                    album["audio_url"] = archive_url
                    album["audio_available"] = True
                else:
                    # Fallback to search if no direct match
                    album["audio_available"] = True
        else:
            # Unknown source - try Deezer
            album = await deezer_service.get_album(album_id)
        
        if not album:
            raise HTTPException(status_code=404, detail="Album not found")
        return album
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Album fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/playlist/{playlist_id}")
async def get_playlist(playlist_id: str):
    """Get playlist details with all tracks."""
    try:
        playlist = await spotify_service.get_playlist(playlist_id)
        if not playlist:
            raise HTTPException(status_code=404, detail="Playlist not found")
        return playlist
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Playlist fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/artist/{artist_id}")
async def get_artist(artist_id: str):
    """Get artist details with top tracks."""
    try:
        # Use Deezer for dz_ prefixed IDs
        if artist_id.startswith("dz_"):
            artist = await deezer_service.get_artist(artist_id)
        else:
            artist = await spotify_service.get_artist(artist_id)
        if not artist:
            raise HTTPException(status_code=404, detail="Artist not found")
        return artist
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Artist fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.api_route("/api/stream/{isrc}", methods=["GET", "HEAD"])
async def stream_audio(
    request: Request,
    isrc: str,
    q: Optional[str] = Query(None, description="Search query hint"),
    hifi: bool = Query(False, description="Stream raw FLAC instead of MP3 (faster, larger)")
):
    """Stream audio for a track by ISRC."""
    try:
        logger.info(f"Stream request for ISRC: {isrc} (hifi={hifi})")
        
        # For LINK: prefixed IDs pointing to direct audio files, proxy the stream
        # (Redirect causes CORS issues with Web Audio API equalizer)
        if isrc.startswith("LINK:"):
            import base64
            import httpx
            from urllib.parse import urlparse
            from fastapi.responses import StreamingResponse
            try:
                encoded_url = isrc.replace("LINK:", "")
                original_url = base64.urlsafe_b64decode(encoded_url).decode()
                
                # Check if it's a direct audio file
                parsed = urlparse(original_url)
                audio_extensions = ('.mp3', '.m4a', '.ogg', '.wav', '.aac', '.opus')
                if any(parsed.path.lower().endswith(ext) for ext in audio_extensions):
                    logger.info(f"Proxying direct audio URL: {original_url[:60]}...")
                    
                    # Stream proxy - fetch and forward without transcoding
                    async def stream_audio_proxy():
                        async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
                            async with client.stream("GET", original_url) as response:
                                async for chunk in response.aiter_bytes(chunk_size=65536):
                                    yield chunk
                    
                    # Determine content type
                    ext = parsed.path.lower().split('.')[-1]
                    content_types = {
                        'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'ogg': 'audio/ogg',
                        'wav': 'audio/wav', 'aac': 'audio/aac', 'opus': 'audio/opus'
                    }
                    content_type = content_types.get(ext, 'audio/mpeg')
                    
                    return StreamingResponse(
                        stream_audio_proxy(),
                        media_type=content_type,
                        headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600"}
                    )
            except Exception as e:
                logger.warning(f"Failed to proxy LINK: {e}")
                # Fall through to normal processing
        
        # YouTube Music tracks - use yt-dlp directly with YouTube URL
        if isrc.startswith("ytm_"):
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
            from fastapi.responses import StreamingResponse
            import httpx
            
            stream_url = audio_service._get_stream_url(youtube_url)
            if not stream_url:
                raise HTTPException(status_code=404, detail="Could not extract YouTube Music audio URL")
            
            logger.info(f"Proxying YTM audio directly (no transcode): {stream_url[:60]}...")
            
            # Proxy the stream directly - no transcoding needed, browsers play Opus/AAC natively
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
        
        # HiFi Mode: Stream raw FLAC (no transcoding)
        if hifi:
            cache_ext = "flac"
            mime_type = "audio/flac"
        else:
            cache_ext = "mp3"
            mime_type = "audio/mpeg"
        
        # Check cache
        if is_cached(isrc, cache_ext):
            cache_path = get_cache_path(isrc, cache_ext)
            logger.info(f"Serving from cache ({cache_ext}): {cache_path}")
            return FileResponse(
                cache_path,
                media_type=mime_type,
                headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"}
            )
        
        # HiFi Mode: Stream proxy for fast playback (no transcoding)
        if hifi:
            try:
                from fastapi.responses import StreamingResponse
                
                logger.info(f"HiFi: Getting stream URL for {isrc} with query: {q}")
                
                # Get stream URL from Tidal (search by query if needed)
                stream_url = None
                
                # Try to get Tidal track by searching with query
                if q:
                    tidal_track = await audio_service.search_tidal_by_isrc(isrc, q)
                    if tidal_track:
                        track_id = tidal_track.get("id")
                        stream_url = await audio_service.get_tidal_download_url(track_id)
                
                if not stream_url:
                    logger.warning(f"HiFi: No stream URL found, falling back to MP3 transcode")
                else:
                    logger.info(f"HiFi: Streaming from {stream_url[:60]}...")
                    
                    # Stream proxy - forward audio chunks as they arrive
                    async def stream_proxy():
                        try:
                            async with audio_service.client.stream("GET", stream_url, timeout=300.0) as response:
                                if response.status_code == 200:
                                    async for chunk in response.aiter_bytes(chunk_size=65536):
                                        yield chunk
                                else:
                                    logger.error(f"HiFi: Stream failed with status {response.status_code}")
                        except Exception as e:
                            logger.error(f"HiFi: Stream proxy error: {e}")
                    
                    # Detect content type from URL
                    content_type = "audio/flac"
                    format_name = "FLAC"
                    if ".mp4" in stream_url or ".m4a" in stream_url:
                        content_type = "audio/mp4"
                        format_name = "AAC"
                    elif ".mp3" in stream_url:
                        content_type = "audio/mpeg"
                        format_name = "MP3"
                    
                    # For HEAD requests, just return headers (for format detection)
                    if request.method == "HEAD":
                        return Response(
                            content=b"",
                            media_type=content_type,
                            headers={
                                "Accept-Ranges": "bytes",
                                "Cache-Control": "no-cache",
                                "X-Audio-Format": format_name
                            }
                        )
                    
                    return StreamingResponse(
                        stream_proxy(),
                        media_type=content_type,
                        headers={
                            "Accept-Ranges": "bytes",
                            "Cache-Control": "no-cache",
                            "X-Audio-Format": format_name
                        }
                    )
            except Exception as e:
                logger.error(f"HiFi: Error setting up stream proxy: {e}")
            
            # Fall back to MP3 transcode if stream proxy fails
            logger.info(f"HiFi fallback: Using MP3 transcode for {isrc}")
            mp3_data = await audio_service.get_audio_stream(isrc, q or "")
            if mp3_data:
                return Response(
                    content=mp3_data,
                    media_type="audio/mpeg",
                    headers={
                        "Accept-Ranges": "bytes",
                        "Content-Length": str(len(mp3_data)),
                        "Cache-Control": "public, max-age=86400",
                        "X-Audio-Format": "MP3"
                    }
                )
            raise HTTPException(status_code=404, detail="Could not fetch audio")
        
        # Standard: Fetch and transcode to MP3
        mp3_data = await audio_service.get_audio_stream(isrc, q or "")
        
        if not mp3_data:
            raise HTTPException(status_code=404, detail="Could not fetch audio")
        
        return Response(
            content=mp3_data,
            media_type="audio/mpeg",
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(len(mp3_data)),
                "Cache-Control": "public, max-age=86400"
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stream error for {isrc}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/download/{isrc}")
async def download_audio(
    isrc: str,
    q: Optional[str] = Query(None, description="Search query hint"),
    format: str = Query("mp3", description="Audio format: mp3, flac, aiff, wav, alac"),
    filename: Optional[str] = Query(None, description="Filename")
):
    """Download audio in specified format."""
    try:
        logger.info(f"Download request for {isrc} in {format}")
        
        result = await audio_service.get_download_audio(isrc, q or "", format)
        
        if not result:
            raise HTTPException(status_code=404, detail="Could not fetch audio for download")
        
        data, ext, mime = result
        download_name = filename if filename else f"{isrc}{ext}"
        if not download_name.endswith(ext):
            download_name += ext
            
        return Response(
            content=data,
            media_type=mime,
            headers={
                "Content-Disposition": f'attachment; filename="{download_name}"',
                "Content-Length": str(len(data))
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Download error for {isrc}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ========== DJ MODE ENDPOINTS ==========

class TrackForFeatures(BaseModel):
    id: str
    isrc: Optional[str] = None
    name: Optional[str] = None
    artists: Optional[str] = None


class AudioFeaturesBatchRequest(BaseModel):
    tracks: List[TrackForFeatures]


class TrackForSetlist(BaseModel):
    id: str
    name: str
    artists: str
    bpm: int
    camelot: str
    energy: float


class SetlistRequest(BaseModel):
    tracks: List[TrackForSetlist]
    style: str = "progressive"  # progressive, peak-time, chill, journey


@app.get("/api/audio-features/{track_id}")
async def get_audio_features(
    track_id: str,
    isrc: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
    artist: Optional[str] = Query(None)
):
    """Get audio features (BPM, key, energy) for a track."""
    try:
        features = await spotify_service.get_audio_features(track_id, isrc, name, artist)
        if not features:
            raise HTTPException(status_code=404, detail="Audio features not found")
        return features
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Audio features error for {track_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/audio-features/batch")
async def get_audio_features_batch(request: AudioFeaturesBatchRequest):
    """Get audio features for multiple tracks."""
    try:
        if not request.tracks:
            return {"features": []}
        
        # Process each track, handling Deezer tracks with ISRC/name lookup
        features = []
        for track in request.tracks:
            feat = await spotify_service.get_audio_features(
                track.id, 
                track.isrc, 
                track.name, 
                track.artists
            )
            
            # Fallback to AI estimation if Spotify fails
            if not feat and track.name and track.artists:
                feat = await dj_service.get_audio_features_ai(track.name, track.artists)
                if feat:
                    feat['track_id'] = track.id  # Match requested ID for frontend cache
            
            features.append(feat)
        
        return {"features": features}
    except Exception as e:
        logger.error(f"Batch audio features error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"Batch audio features error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/dj/generate-setlist")
async def generate_setlist(request: SetlistRequest):
    """Generate AI-optimized DJ setlist ordering."""
    try:
        tracks = [t.model_dump() for t in request.tracks]
        result = await dj_service.generate_setlist(tracks, request.style)
        return result
    except Exception as e:
        logger.error(f"Setlist generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class MoodSearchRequest(BaseModel):
    query: str


@app.post("/api/search/mood")
async def search_by_mood(request: MoodSearchRequest):
    """Interpret a natural language mood query using AI and return search terms."""
    try:
        result = await dj_service.interpret_mood_query(request.query)
        if not result:
            # Fallback: just return the query as a search term
            return {
                "search_terms": [request.query],
                "moods": [],
                "bpm_range": None,
                "energy": "medium",
                "description": f"Searching for: {request.query}"
            }
        return result
    except Exception as e:
        logger.error(f"Mood search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class SeedTrack(BaseModel):
    name: str
    artists: str
    bpm: Optional[int] = None
    camelot: Optional[str] = None


class QueueTrack(BaseModel):
    name: str
    artists: str


class AIRadioRequest(BaseModel):
    seed_track: Optional[SeedTrack] = None
    mood: Optional[str] = None
    current_queue: Optional[List[QueueTrack]] = None
    count: int = 5


@app.post("/api/ai-radio/generate")
async def generate_ai_radio_recommendations(request: AIRadioRequest):
    """Generate AI Radio recommendations based on seed track or mood."""
    try:
        seed = request.seed_track.model_dump() if request.seed_track else None
        queue = [t.model_dump() for t in request.current_queue] if request.current_queue else []
        
        result = await ai_radio_service.generate_recommendations(
            seed_track=seed,
            mood=request.mood,
            current_queue=queue,
            count=request.count
        )
        return result
    except Exception as e:
        logger.error(f"AI Radio error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class BatchDownloadRequest(BaseModel):
    tracks: List[str]  # List of ISRCs or IDs
    names: List[str]   # List of track names for filenames
    artists: List[str] # List of artist names
    album_name: str
    format: str = "mp3"


@app.post("/api/download-batch")
async def download_batch(request: BatchDownloadRequest):
    """Download multiple tracks as a ZIP file."""
    try:
        logger.info(f"Batch download request: {len(request.tracks)} tracks from {request.album_name}")
        
        # In-memory ZIP buffer
        zip_buffer = io.BytesIO()
        
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            used_names = set()
            
            # Process sequentially for better reliability
            for i, isrc in enumerate(request.tracks):
                try:
                    query = f"{request.names[i]} {request.artists[i]}"
                    result = await audio_service.get_download_audio(isrc, query, request.format)
                    
                    if result:
                        data, ext, _ = result
                        # Clean filename
                        safe_name = f"{request.artists[i]} - {request.names[i]}".replace("/", "_").replace("\\", "_").replace(":", "_").replace("*", "").replace("?", "").replace('"', "").replace("<", "").replace(">", "").replace("|", "")
                        filename = f"{safe_name}{ext}"
                        
                        # Handle duplicates
                        count = 1
                        base_filename = filename
                        while filename in used_names:
                            filename = f"{safe_name} ({count}){ext}"
                            count += 1
                        used_names.add(filename)
                        
                        zip_file.writestr(filename, data)
                except Exception as e:
                    logger.error(f"Failed to download track {isrc}: {e}")
                    # Continue with other tracks
        
        zip_buffer.seek(0)
        safe_album = request.album_name.replace("/", "_").replace("\\", "_").replace(":", "_")
        filename = f"{safe_album}.zip"
        
        return Response(
            content=zip_buffer.getvalue(),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"'
            }
        )
        
    except Exception as e:
        logger.error(f"Batch download error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ========== GOOGLE DRIVE ==========

class UploadToDriveRequest(BaseModel):
    isrc: str
    access_token: str
    format: str = "aiff"
    folder_id: Optional[str] = None
    filename: Optional[str] = None
    q: Optional[str] = None


@app.post("/api/drive/upload")
async def upload_to_drive(request: UploadToDriveRequest):
    """Download audio, transcode, and upload to Google Drive."""
    try:
        logger.info(f"Drive upload request for {request.isrc} in {request.format}")
        
        # 1. Get Audio Data (reuse existing logic)
        result = await audio_service.get_download_audio(request.isrc, request.q or "", request.format)
        
        if not result:
            raise HTTPException(status_code=404, detail="Could not fetch audio")
        
        data, ext, mime = result
        filename = request.filename if request.filename else f"{request.isrc}{ext}"
        if not filename.endswith(ext):
            filename += ext
            
        # 2. Upload to Drive (Multipart upload for metadata + media)
        metadata = {
            'name': filename,
            'mimeType': mime
        }
        if request.folder_id:
            metadata['parents'] = [request.folder_id]
        
        import httpx
        import json
        
        async with httpx.AsyncClient() as client:
            # Multipart upload
            files_param = {
                'metadata': (None, json.dumps(metadata), 'application/json; charset=UTF-8'),
                'file': (filename, data, mime)
            }
            
            drive_response = await client.post(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
                headers={'Authorization': f'Bearer {request.access_token}'},
                files=files_param,
                timeout=300.0 # 5 minutes for upload
            )
            
            if drive_response.status_code != 200:
                logger.error(f"Drive upload failed: {drive_response.text}")
                raise HTTPException(status_code=500, detail=f"Drive upload failed: {drive_response.text}")
                
            file_data = drive_response.json()
            return {"file_id": file_data.get('id'), "name": file_data.get('name')}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Drive upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ========== STATIC FILES ==========

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    """Serve the main page."""
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "Freedify Streaming Server", "docs": "/docs"}


@app.get("/manifest.json")
async def manifest():
    """Serve PWA manifest."""
    manifest_path = os.path.join(STATIC_DIR, "manifest.json")
    if os.path.exists(manifest_path):
        return FileResponse(manifest_path, media_type="application/json")
    raise HTTPException(status_code=404)


@app.get("/sw.js")
async def service_worker():
    """Serve service worker."""
    sw_path = os.path.join(STATIC_DIR, "sw.js")
    if os.path.exists(sw_path):
        return FileResponse(sw_path, media_type="application/javascript")
    raise HTTPException(status_code=404)


# ==================== LISTENBRAINZ ENDPOINTS ====================

@app.post("/api/listenbrainz/now-playing")
async def listenbrainz_now_playing(track: dict):
    """Submit 'now playing' status to ListenBrainz."""
    success = await listenbrainz_service.submit_now_playing(track)
    return {"success": success}


@app.post("/api/listenbrainz/scrobble")
async def listenbrainz_scrobble(track: dict, listened_at: Optional[int] = None):
    """Submit a completed listen to ListenBrainz."""
    success = await listenbrainz_service.submit_listen(track, listened_at)
    return {"success": success}


@app.get("/api/listenbrainz/validate")
async def listenbrainz_validate():
    """Validate ListenBrainz token and return username."""
    username = await listenbrainz_service.validate_token()
    return {"valid": username is not None, "username": username}


@app.get("/api/listenbrainz/recommendations/{username}")
async def listenbrainz_recommendations(username: str, count: int = 25):
    """Get personalized recommendations for a user."""
    recommendations = await listenbrainz_service.get_recommendations(username, count)
    return {"recommendations": recommendations, "count": len(recommendations)}


@app.get("/api/listenbrainz/listens/{username}")
async def listenbrainz_listens(username: str, count: int = 25):
    """Get recent listens for a user."""
    listens = await listenbrainz_service.get_user_listens(username, count)
    return {"listens": listens, "count": len(listens)}


@app.post("/api/listenbrainz/set-token")
async def listenbrainz_set_token(token: str):
    """Set ListenBrainz user token (from settings UI)."""
    listenbrainz_service.set_token(token)
    username = await listenbrainz_service.validate_token()
    return {"valid": username is not None, "username": username}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        reload=True
    )
