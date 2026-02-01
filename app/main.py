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
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import zipfile
import io
from typing import List
import httpx


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
from app.jamendo_service import jamendo_service
from app.genius_service import genius_service
from app.concert_service import concert_service

from app.cache import cleanup_cache, periodic_cleanup, is_cached, get_cache_path
from app import library

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


@app.get("/api/config")
async def get_config():
    """Get public configuration for the frontend (like Google Client ID)."""
    return {
        "google_client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
    }

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
        
        # Regular search - Use Dab Music (Priority) then Deezer
        logger.info(f"Searching: {q} (type: {type}, offset: {offset})")
        
        results = []
        source = "deezer"
        
        # 1. Try Dab Music (unless offset > 0, as Dab paging is limited/untested or we want fast fallback)
        # Actually Dab search wrapper I wrote doesn't support offset yet (defaults limit 10).
        # We'll use Dab for generic queries.
        if type in ["album", "track"] and offset == 0:
            try:
                from app.dab_service import dab_service
                if type == "album":
                    dab_results = await dab_service.search_albums(q, limit=10)
                else:
                    dab_results = await dab_service.search_tracks(q, limit=10)
                
                if dab_results:
                    logger.info(f"Found {len(dab_results)} results on Dab Music")
                    results = dab_results
                    source = "dab"
            except Exception as e:
                logger.error(f"Dab search error: {e}")

        # 2. Fallback to Deezer if no Dab results
        if not results:
            logger.info(f"Falling back to Deezer search...")
            if type == "album":
                results = await deezer_service.search_albums(q, limit=20, offset=offset)
            elif type == "artist":
                results = await deezer_service.search_artists(q, limit=20, offset=offset)
            else:
                results = await deezer_service.search_tracks(q, limit=20, offset=offset)
            if results:
                source = "deezer"
        
        # 3. Final fallback to Jamendo (independent/CC music) if still no results
        if not results and type in ["track", "album", "artist"]:
            logger.info(f"Falling back to Jamendo search...")
            try:
                if type == "album":
                    results = await jamendo_service.search_albums(q, limit=20, offset=offset)
                elif type == "artist":
                    results = await jamendo_service.search_artists(q, limit=20, offset=offset)
                else:
                    results = await jamendo_service.search_tracks(q, limit=20, offset=offset)
                if results:
                    source = "jamendo"
                    logger.info(f"Found {len(results)} results on Jamendo")
            except Exception as e:
                logger.error(f"Jamendo search error: {e}")
        
        return {"results": results, "query": q, "type": type, "source": source, "offset": offset}
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def get_content_by_type(content_type: str, item_id: str):
    """Helper to get content by type and ID (uses Deezer, Dab, or Jamendo)."""
    
    # Handle Dab Music IDs
    if item_id.startswith("dab_"):
        from app.dab_service import dab_service
        if content_type == "album":
            album = await dab_service.get_album(item_id)
            if album:
                return {"results": [album], "type": "album", "is_url": True, "tracks": album.get("tracks", [])}
        # Dab doesn't really have "get_track" singular metadata endpoint exposed yet, but we can search or use stream.
        # But for UI "open track", usually it plays directly.
        pass
    
    # Handle Jamendo IDs (jm_ prefix)
    if item_id.startswith("jm_"):
        if content_type == "album":
            album = await jamendo_service.get_album(item_id)
            if album:
                return {"results": [album], "type": "album", "is_url": True, "tracks": album.get("tracks", []), "source": "jamendo"}
        elif content_type == "artist" or item_id.startswith("jm_artist_"):
            artist = await jamendo_service.get_artist(item_id)
            if artist:
                return {"results": [artist], "type": "artist", "is_url": True, "tracks": artist.get("tracks", []), "source": "jamendo"}
        elif content_type == "track":
            track = await jamendo_service.get_track(item_id)
            if track:
                return {"results": [track], "type": "track", "is_url": True, "source": "jamendo"}
        raise HTTPException(status_code=404, detail=f"Jamendo {content_type} not found")

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
    # Support Dab Albums
    if album_id.startswith("dab_"):
        from app.dab_service import dab_service
        album = await dab_service.get_album(album_id)
        if album: return album
        raise HTTPException(status_code=404, detail="Dab album not found")
        
    # Support Deezer Albums (fallback logic handled in dedicated service or here)
    if album_id.startswith("dz_"):
        album = await deezer_service.get_album(album_id)
        if album: return album
        raise HTTPException(status_code=404, detail="Deezer album not found")

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
        elif album_id.startswith("itunes_"):
            # iTunes Podcast - fetch episodes via RSS
            album = await podcast_service.get_podcast_episodes(album_id)
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
    hires: bool = Query(True, description="Prefer Hi-Res 24-bit audio")
):
    """Stream audio for a track by ISRC."""
    try:
        logger.info(f"Stream request for ISRC: {isrc} (hires={hires})")

        # 0. Check Library first (permanent user storage)
        try:
            track_info = await library.get_track_info(isrc)
            if track_info:
                format = track_info.get("format", "flac")
                file_path = await library.get_track_file_path(isrc)
                if file_path and file_path.exists():
                    logger.info(f"Serving from library: {file_path}")
                    mime_type = "audio/flac" if format == "flac" else f"audio/{format}"
                    return FileResponse(
                        file_path,
                        media_type=mime_type,
                        headers={
                            "Accept-Ranges": "bytes",
                            "Cache-Control": "public, max-age=86400",
                            "X-Source": "library"
                        }
                    )
                else:
                    # File missing - clean up orphaned index entry
                    logger.warning(f"Library file missing, cleaning index: {isrc}")
                    await library.delete_track(isrc)
        except Exception as e:
            logger.warning(f"Library check failed: {e}")

        target_stream_url = None

        # 1. Resolve Target Stream URL (Direct or via yt-dlp)
        
        # Handle Imported Links (LINK:)
        if isrc.startswith("LINK:"):
            import base64
            from urllib.parse import urlparse
            try:
                encoded_url = isrc.replace("LINK:", "")
                original_url = base64.urlsafe_b64decode(encoded_url).decode()
                
                # Check for direct file extension first (fast path)
                parsed = urlparse(original_url)
                audio_exts = ('.mp3', '.m4a', '.ogg', '.wav', '.aac', '.opus', '.flac')
                if any(parsed.path.lower().endswith(ext) for ext in audio_exts):
                     target_stream_url = original_url
                else:
                    # Try to extract stream via yt-dlp (for YouTube/SoundCloud links)
                    # Run in executor to avoid blocking
                    loop = asyncio.get_event_loop()
                    target_stream_url = await loop.run_in_executor(None, audio_service._get_stream_url, original_url)
                    
            except Exception as e:
                logger.warning(f"Failed to parse/extract LINK: {e}")

        # Handle YouTube Music (ytm_)
        elif isrc.startswith("ytm_"):
             video_id = isrc.replace("ytm_", "")
             youtube_url = f"https://music.youtube.com/watch?v={video_id}"
             loop = asyncio.get_event_loop()
             target_stream_url = await loop.run_in_executor(None, audio_service._get_stream_url, youtube_url)

        # Handle Jamendo (jm_) - Direct stream/download URLs
        elif isrc.startswith("jm_"):
            track_id = isrc.replace("jm_", "")
            target_stream_url = await jamendo_service.get_stream_url(track_id, prefer_flac=hires)

        # 2. Proxy the Target Stream (if found)
        if target_stream_url:
            logger.info(f"Proxying direct stream: {target_stream_url[:60]}...")
            
            # Forward Range header to support seeking
            req_headers = {}
            if request.headers.get("Range"):
                req_headers["Range"] = request.headers.get("Range")
                logger.info(f"Forwarding Range header: {req_headers['Range']}")



            try:
                # Use a dedicated client per request, managed by a generator with context manager.
                # This guarantees cleanup when the generator is closed (e.g. client disconnect).
                # This avoids "Shared Client" pool exhaustion/deadlocks.
                
                async def stream_generator():
                    try:
                        # 60s timeout, follow redirects
                        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                            req = client.build_request("GET", target_stream_url, headers=req_headers)
                            async with client.stream(req.method, req.url, headers=req.headers) as r:
                                # We've started the stream. Now we need to yield data.
                                # But wait, we need to return status_code and headers to FastAPI *before* we yield data 
                                # if we use standard StreamingResponse... 
                                
                                # Actually, StreamingResponse takes a generator for content.
                                # But it needs status and headers passed in the constructor.
                                # Be we can't get them until we make the request!
                                
                                # This is the "Streaming Problem".
                                # Solution: use a separate setup request (HEAD) or...
                                # Accept that we make the request *outside* the generator for headers, 
                                # but risking the cleanup issue?
                                
                                # NO. The cleanup issue is paramount.
                                # If we can't get headers cleanly without risking leaks, we should assume defaults 
                                # or use a dummy request?
                                
                                # ALTERNATIVE: Use the shared client again, BUT with a much more aggressive timeout?
                                # OR use the pattern where we don't return StreamingResponse until we have headers,
                                # ensuring we use a try/finally block that closes the client.
                                
                                # Let's stick to the pattern I implemented before but simpler:
                                # 1. Create client
                                # 2. Make request
                                # 3. Return StreamingResponse with a generator that CLOSES the client.
                                # 4. BUT ensure `client` is a LOCALLY created instance, not shared.
                                pass
                                
                    except Exception as e:
                        logger.error(f"Generator error: {e}")

                # Real Implementation:
                # Create a local client instance (not shared).
                client = httpx.AsyncClient(follow_redirects=True, timeout=60.0)
                req = client.build_request("GET", target_stream_url, headers=req_headers)
                r = await client.send(req, stream=True)
                
                # Prepare headers
                resp_headers = {
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "public, max-age=3600",
                    "Access-Control-Allow-Origin": "*"
                }
                for key in ["Content-Range", "Content-Length", "Content-Type", "Last-Modified", "ETag"]:
                    if r.headers.get(key):
                        resp_headers[key] = r.headers[key]
                
                # Custom iterator that closes the LOCAL client
                async def response_iterator():
                    try:
                        async for chunk in r.aiter_bytes(chunk_size=65536):
                            yield chunk
                    except Exception as e:
                        logger.error(f"Stream iteration error: {e}")
                    finally:
                        # Close the response AND the client
                        await r.aclose()
                        await client.aclose()
                
                return StreamingResponse(
                    response_iterator(),
                    status_code=r.status_code,
                    media_type=r.headers.get("Content-Type", "audio/mpeg"),
                    headers=resp_headers
                )
            except Exception as e:
                logger.error(f"Proxying stream failed: {e}")
                # Fall through to standard playback if proxy fails
        
        # 3. Standard / HiFi Playback (Fallback or standard sources)
        
        # Force FLAC/Hi-Res path (MP3 option removed)
        cache_ext = "flac"
        mime_type = "audio/flac"
        
        # Check cache
        if is_cached(isrc, cache_ext):
            cache_path = get_cache_path(isrc, cache_ext)
            logger.info(f"Serving from cache ({cache_ext}): {cache_path}")
            return FileResponse(
                cache_path,
                media_type=mime_type,
                headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"}
            )
        
        
        # 4. Standard / HiFi Playback (Uses fetch_flac with internal priorities: Dab -> Tidal -> Deezer)
        
        # Standard: Fetch FLAC directly (Hifi/Hi-Res) - Skip MP3 transcoding
        # The user requested to remove non-hifi options for efficiency.
        result = await audio_service.fetch_flac(isrc, q or "", hires=hires)
        
        if not result:
            raise HTTPException(status_code=404, detail="Could not fetch audio")
            
        # Check if result is URL (tuple[str, dict]) or Bytes (tuple[bytes, dict])
        if isinstance(result[0], str):
            # It's a URL! Stream it via proxy
            target_stream_url = result[0]
            metadata = result[1]
            logger.info(f"Streaming via proxy from URL: {target_stream_url[:50]}...")
            
            # Proxy streaming logic for fetched URL
            # Need to handle Range requests properly for seeking
            
            req_headers = {}
            if request.headers.get("Range"):
                req_headers["Range"] = request.headers.get("Range")
                logger.info(f"Forwarding Range header: {req_headers['Range']}")

            # Make initial request to get status/headers
            client = httpx.AsyncClient(timeout=60.0, follow_redirects=True)
            try:
                upstream_req = client.build_request("GET", target_stream_url, headers=req_headers)
                upstream_resp = await client.send(upstream_req, stream=True)
                
                # Build response headers
                resp_headers = {
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "public, max-age=3600",
                    "Access-Control-Allow-Origin": "*"
                }
                
                # Forward important headers from upstream
                for key in ["Content-Range", "Content-Length", "Content-Type"]:
                    if upstream_resp.headers.get(key):
                        resp_headers[key] = upstream_resp.headers[key]
                
                if metadata and metadata.get("is_hi_res"):
                    resp_headers["X-Audio-Quality"] = "Hi-Res"
                    resp_headers["X-Audio-Format"] = "FLAC"

                # Iterator that closes client when done
                async def response_iterator():
                    try:
                        async for chunk in upstream_resp.aiter_bytes(chunk_size=65536):
                            yield chunk
                    except Exception as e:
                        logger.error(f"Stream iteration error: {e}")
                    finally:
                        await upstream_resp.aclose()
                        await client.aclose()
                
                return StreamingResponse(
                    response_iterator(),
                    status_code=upstream_resp.status_code,  # 200 or 206
                    media_type=upstream_resp.headers.get("Content-Type", "audio/flac"), 
                    headers=resp_headers
                )
            except Exception as e:
                await client.aclose()
                raise
            
        else:
            # It's bytes! Serve directly.
            flac_data, metadata = result
            
            headers = {
                "Accept-Ranges": "bytes",
                "Content-Length": str(len(flac_data)),
                "Cache-Control": "public, max-age=86400",
                "X-Audio-Format": "FLAC"
            }
            
            if metadata and metadata.get("is_hi_res"):
                headers["X-Audio-Quality"] = "Hi-Res"
                
            return Response(
                content=flac_data,
                media_type="audio/flac",
                headers=headers
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


# ==================== AI ASSISTANT ENDPOINTS ====================

class GeneratePlaylistRequest(BaseModel):
    description: str
    duration_mins: int = 60

@app.post("/api/ai/generate-playlist")
async def ai_generate_playlist(request: GeneratePlaylistRequest):
    """Generate a playlist from a natural language description."""
    try:
        result = await ai_radio_service.generate_playlist(
            description=request.description,
            duration_mins=request.duration_mins
        )
        return result
    except Exception as e:
        logger.error(f"Playlist generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Global progress store
# Format: { "download_id": { "current": 0, "total": 0, "status": "processing" } }
download_progress = {}

class BatchDownloadRequest(BaseModel):
    tracks: List[str]  # List of ISRCs or IDs
    names: List[str]   # List of track names for filenames
    artists: List[str] # List of artist names
    album_name: Optional[str] = None
    zip_name: Optional[str] = None
    format: str = "mp3"
    part: int = 1          # Part number for multi-part downloads
    total_parts: int = 1   # Total number of parts
    download_id: Optional[str] = None # Unique ID for progress tracking
    # Optional metadata for embedding (from frontend)
    album_art_urls: Optional[List[str]] = None  # Cover art URLs per track
    release_year: Optional[str] = None  # Album release year
    is_playlist: bool = False


@app.get("/api/progress/{download_id}")
async def get_progress(download_id: str):
    """Get status of a background download"""
    return download_progress.get(download_id, {"current": 0, "total": 0, "status": "unknown"})


@app.post("/api/download-batch")
async def download_batch(request: BatchDownloadRequest):
    """Download multiple tracks as a ZIP file with parallel processing."""
    try:
        final_name = request.zip_name or request.album_name or "download"
        logger.info(f"Batch download request: {len(request.tracks)} tracks from {final_name}")
        
        # In-memory ZIP buffer
        zip_buffer = io.BytesIO()
        
        # Initialize progress tracking
        if request.download_id:
            download_progress[request.download_id] = {
                "current": 0, 
                "total": len(request.tracks),
                "status": "processing"
            }
        
        # Concurrency control (3 concurrent downloads)
        semaphore = asyncio.Semaphore(3)
        zip_lock = asyncio.Lock()
        used_names = set()
        
        async def process_track(i: int, isrc: str):
            async with semaphore:
                try:
                    logger.info(f"Starting track {i+1}/{len(request.tracks)}: {request.names[i]}")
                    
                    query = f"{request.names[i]} {request.artists[i]}"
                    
                    # Build metadata
                    provided_metadata = {
                        "title": request.names[i],
                        "artists": request.artists[i],
                        "album": request.album_name,
                        "year": request.release_year or "",
                        "album_art_url": request.album_art_urls[i] if request.album_art_urls and i < len(request.album_art_urls) else None,
                        "total_tracks": len(request.tracks) * request.total_parts if request.album_name else None
                    }
                    
                    # Download
                    result = await audio_service.get_download_audio(
                        isrc, 
                        query, 
                        request.format,
                        track_number=i+1,
                        provided_metadata=provided_metadata
                    )
                    
                    if result:
                        data, ext, _ = result
                        
                        # Calculate filename
                        safe_name = f"{request.artists[i]} - {request.names[i]}".replace("/", "_").replace("\\", "_").replace(":", "_").replace("*", "").replace("?", "").replace('"', "").replace("<", "").replace(">", "").replace("|", "")
                        filename = f"{safe_name}{ext}"
                        
                        # Write to ZIP (atomic operation via lock)
                        async with zip_lock:
                            # Handle duplicates
                            count = 1
                            base_filename = filename
                            while filename in used_names:
                                filename = f"{safe_name} ({count}){ext}"
                                count += 1
                            used_names.add(filename)
                            
                            zip_file.writestr(filename, data)
                            logger.info(f"Added to ZIP: {filename}")
                            
                            # Update progress
                            if request.download_id:
                                download_progress[request.download_id]["current"] += 1
                                
                except Exception as e:
                    logger.error(f"Failed to download track {isrc}: {e}")
                    # Don't raise, just continue (partial success)
        
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            # Create tasks
            tasks = [process_track(i, isrc) for i, isrc in enumerate(request.tracks)]
            await asyncio.gather(*tasks)

        # Cleanup progress
        if request.download_id and request.download_id in download_progress:
            del download_progress[request.download_id]
        
        zip_buffer.seek(0)
        final_name = request.zip_name or request.album_name or "download"
        safe_album = final_name.replace("/", "_").replace("\\", "_").replace(":", "_")
        
        # Name ZIP with part number
        if request.total_parts > 1:
            filename = f"{safe_album} (Part {request.part} of {request.total_parts}).zip"
        else:
            filename = f"{safe_album}.zip"
        
        logger.info(f"ZIP complete: {filename} ({len(zip_buffer.getvalue())} bytes)")
        
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


# ========== SERVER LIBRARY ==========

class LibrarySaveRequest(BaseModel):
    """Request to save track(s) to server library."""
    isrc: str
    q: Optional[str] = None  # Search query hint
    format: str = "flac"
    # Optional metadata to store
    name: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    album_art: Optional[str] = None


class LibrarySaveBatchRequest(BaseModel):
    """Request to save multiple tracks to server library."""
    tracks: List[LibrarySaveRequest]


@app.post("/api/library/save")
async def library_save(request: LibrarySaveRequest):
    """Save a track to the server library for local playback."""
    try:
        logger.info(f"Library save request: {request.isrc} ({request.format})")

        # Check if already exists
        if await library.track_exists(request.isrc, request.format):
            logger.info(f"Track already in library: {request.isrc}")
            return {"success": True, "message": "Already in library", "isrc": request.isrc}

        # Fetch the audio
        result = await audio_service.get_download_audio(
            request.isrc,
            request.q or "",
            request.format
        )

        if not result:
            raise HTTPException(status_code=404, detail="Could not fetch audio")

        data, ext, mime = result

        # Build metadata
        metadata = {}
        if request.name:
            metadata["name"] = request.name
        if request.artist:
            metadata["artist"] = request.artist
        if request.album:
            metadata["album"] = request.album
        if request.album_art:
            metadata["album_art"] = request.album_art

        # Save to library
        success = await library.add_track(
            request.isrc,
            data,
            request.format,
            metadata
        )

        if not success:
            # Check if storage limit
            stats = await library.get_stats()
            if stats.get("max_size_gb") and stats.get("total_size_gb", 0) >= stats["max_size_gb"]:
                raise HTTPException(
                    status_code=507,
                    detail=f"Library storage limit reached ({stats['max_size_gb']} GB)"
                )
            raise HTTPException(status_code=500, detail="Failed to save to library")

        return {
            "success": True,
            "message": "Saved to library",
            "isrc": request.isrc,
            "format": request.format,
            "size_mb": round(len(data) / (1024 * 1024), 2)
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Library save error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/library/save-batch")
async def library_save_batch(request: LibrarySaveBatchRequest):
    """Save multiple tracks to the server library."""
    try:
        results = []
        for track in request.tracks:
            try:
                result = await library_save(track)
                results.append({"isrc": track.isrc, "success": True})
            except HTTPException as e:
                results.append({"isrc": track.isrc, "success": False, "error": e.detail})
            except Exception as e:
                results.append({"isrc": track.isrc, "success": False, "error": str(e)})

        successful = sum(1 for r in results if r.get("success"))
        return {
            "success": successful > 0,
            "saved": successful,
            "total": len(request.tracks),
            "results": results
        }
    except Exception as e:
        logger.error(f"Library batch save error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/library/list")
async def library_list(
    offset: int = Query(0, description="Pagination offset"),
    limit: int = Query(50, description="Number of tracks to return"),
    sort_by: str = Query("added", description="Sort field: added, name, artist, size"),
    sort_desc: bool = Query(True, description="Sort descending")
):
    """List all tracks in the server library."""
    try:
        return await library.list_tracks(offset, limit, sort_by, sort_desc)
    except Exception as e:
        logger.error(f"Library list error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/library/check")
async def library_check(isrcs: str = Query(..., description="Comma-separated ISRCs to check")):
    """Check if tracks exist in the library. Returns dict of ISRC -> exists boolean."""
    try:
        isrc_list = [s.strip() for s in isrcs.split(",") if s.strip()]
        if not isrc_list:
            return {}
        return await library.check_multiple(isrc_list)
    except Exception as e:
        logger.error(f"Library check error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/library/{isrc}")
async def library_delete(isrc: str):
    """Remove a track from the server library."""
    try:
        success = await library.delete_track(isrc)
        if not success:
            raise HTTPException(status_code=404, detail="Track not found in library")
        return {"success": True, "message": "Removed from library", "isrc": isrc}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Library delete error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/library/stats")
async def library_stats():
    """Get library statistics (size, count, formats)."""
    try:
        return await library.get_stats()
    except Exception as e:
        logger.error(f"Library stats error: {e}")
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

@app.get("/api/listenbrainz/playlists/{username}")
async def listenbrainz_playlists(username: str, count: int = 25):
    """Get user's ListenBrainz playlists (includes Weekly Exploration)."""
    playlists = await listenbrainz_service.get_user_playlists(username, count)
    return {"playlists": playlists, "count": len(playlists)}

@app.get("/api/listenbrainz/playlist/{playlist_id}")
async def listenbrainz_playlist_tracks(playlist_id: str):
    """Get tracks from a ListenBrainz playlist."""
    playlist = await listenbrainz_service.get_playlist_tracks(playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist

@app.get("/api/listenbrainz/stats/{username}")
async def listenbrainz_stats(username: str):
    """Get user's ListenBrainz listening statistics."""
    stats = await listenbrainz_service.get_user_stats(username)
    return stats


# ========== GENIUS LYRICS ==========

@app.get("/api/lyrics")
async def get_lyrics(artist: str, title: str):
    """Get lyrics and song info from Genius."""
    result = await genius_service.get_lyrics_and_info(artist, title)
    return result


@app.get("/api/proxy_image")
async def proxy_image(url: str):
    """Proxy image requests to avoid 429 errors/CORS issues."""
    if not url:
        raise HTTPException(status_code=400, detail="No URL provided")
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, follow_redirects=True)
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="Failed to fetch image")
            
            return Response(
                content=resp.content,
                media_type=resp.headers.get("Content-Type", "image/jpeg"),
                headers={
                    "Cache-Control": "public, max-age=86400"
                }
            )
    except Exception as e:
        logger.error(f"Image proxy error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ========== CONCERT ALERTS ENDPOINTS ==========

@app.get("/api/concerts/search")
async def search_concerts(
    artist: str = Query(..., description="Artist name to search"),
    city: Optional[str] = Query(None, description="City to filter events")
):
    """
    Search for upcoming concerts by artist name.
    Uses Ticketmaster with SeatGeek fallback.
    """
    try:
        logger.info(f"Concert search for: {artist} (city: {city})")
        events = await concert_service.search_events(artist, city, limit=20)
        return {"events": events, "artist": artist, "city": city}
    except Exception as e:
        logger.error(f"Concert search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/concerts/for-artists")
async def get_concerts_for_artists(
    artists: str = Query(..., description="Comma-separated list of artist names"),
    cities: Optional[str] = Query(None, description="Comma-separated list of cities")
):
    """
    Get upcoming concerts for multiple artists.
    Useful for showing concerts from recently listened artists.
    """
    try:
        artist_list = [a.strip() for a in artists.split(",") if a.strip()]
        city_list = [c.strip() for c in cities.split(",")] if cities else None
        
        if not artist_list:
            return {"events": [], "artists": [], "cities": city_list}
        
        logger.info(f"Concert search for {len(artist_list)} artists, cities: {city_list}")
        events = await concert_service.get_events_for_artists(artist_list, city_list)
        
        return {"events": events, "artists": artist_list, "cities": city_list}
    except Exception as e:
        logger.error(f"Concerts for artists error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        reload=True
    )
