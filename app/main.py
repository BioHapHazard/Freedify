"""
Freedify Streaming Server
A FastAPI server for streaming music with FFmpeg transcoding.
"""
import os
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.spotify_service import spotify_service
from app.audio_service import audio_service
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
    await spotify_service.close()
    await audio_service.close()
    logger.info("Server shutdown complete.")


app = FastAPI(
    title="Freedify Streaming Server",
    description="Stream music from Spotify/Tidal/Deezer with FFmpeg transcoding",
    version="2.0.0",
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


# ========== MODELS ==========

class ParseUrlRequest(BaseModel):
    url: str


# ========== API ENDPOINTS ==========

@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": "freedify-streaming"}


@app.get("/api/search")
async def search(
    q: str = Query(..., min_length=1, description="Search query"),
    type: str = Query("track", description="Search type: track, album, or artist")
):
    """Search for tracks, albums, or artists."""
    try:
        # Check if it's a Spotify URL
        parsed = spotify_service.parse_spotify_url(q)
        if parsed:
            url_type, item_id = parsed
            return await get_content_by_type(url_type, item_id)
        
        # Regular search
        if type == "album":
            results = await spotify_service.search_albums(q, limit=20)
        elif type == "artist":
            results = await spotify_service.search_artists(q, limit=20)
        else:
            results = await spotify_service.search_tracks(q, limit=20)
        
        return {"results": results, "query": q, "type": type}
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def get_content_by_type(content_type: str, item_id: str):
    """Helper to get content by type and ID."""
    if content_type == "track":
        track = await spotify_service.get_track_by_id(item_id)
        if track:
            return {"results": [track], "type": "track", "is_url": True}
    elif content_type == "album":
        album = await spotify_service.get_album(item_id)
        if album:
            return {"results": [album], "type": "album", "is_url": True, "tracks": album.get("tracks", [])}
    elif content_type == "playlist":
        playlist = await spotify_service.get_playlist(item_id)
        if playlist:
            return {"results": [playlist], "type": "playlist", "is_url": True, "tracks": playlist.get("tracks", [])}
    elif content_type == "artist":
        artist = await spotify_service.get_artist(item_id)
        if artist:
            return {"results": [artist], "type": "artist", "is_url": True, "tracks": artist.get("tracks", [])}
    
    raise HTTPException(status_code=404, detail=f"{content_type.title()} not found")


@app.post("/api/parse-url")
async def parse_url(request: ParseUrlRequest):
    """Parse a Spotify URL and return the content."""
    parsed = spotify_service.parse_spotify_url(request.url)
    if not parsed:
        raise HTTPException(status_code=400, detail="Invalid Spotify URL")
    
    url_type, item_id = parsed
    return await get_content_by_type(url_type, item_id)


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
        album = await spotify_service.get_album(album_id)
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
        artist = await spotify_service.get_artist(artist_id)
        if not artist:
            raise HTTPException(status_code=404, detail="Artist not found")
        return artist
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Artist fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stream/{isrc}")
async def stream_audio(
    isrc: str,
    q: Optional[str] = Query(None, description="Search query hint")
):
    """Stream audio for a track by ISRC."""
    try:
        logger.info(f"Stream request for ISRC: {isrc}")
        
        # Check cache
        if is_cached(isrc, "mp3"):
            cache_path = get_cache_path(isrc, "mp3")
            logger.info(f"Serving from cache: {cache_path}")
            return FileResponse(
                cache_path,
                media_type="audio/mpeg",
                headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"}
            )
        
        # Fetch and transcode
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        reload=True
    )
