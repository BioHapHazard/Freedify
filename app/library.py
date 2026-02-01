"""
Library service for persistent track storage.
Unlike the cache (TTL-based, auto-cleanup), the library is permanent user storage.

File structure: /app/library/tracks/Artist Name/Song Name.flac
"""
import os
import re
import json
import asyncio
import aiofiles
from pathlib import Path
from typing import Optional, Dict, Any, List
import logging
import hashlib
from datetime import datetime

logger = logging.getLogger(__name__)

# Library configuration
_default_library = "/app/library"
LIBRARY_DIR = Path(os.environ.get("LIBRARY_DIR", _default_library))
LIBRARY_MAX_SIZE_GB = float(os.environ.get("LIBRARY_MAX_SIZE_GB", "0"))  # 0 = unlimited

# Index file stores metadata about all tracks in the library
INDEX_FILE = LIBRARY_DIR / "index.json"

# Lock for concurrent index writes
_index_lock = asyncio.Lock()


def ensure_library_dir():
    """Ensure library directory and structure exists."""
    LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
    tracks_dir = LIBRARY_DIR / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    return LIBRARY_DIR


def sanitize_filename(name: str, max_length: int = 100) -> str:
    """Sanitize a string for use as a filename.

    Removes/replaces characters that are invalid in filenames.
    """
    if not name:
        return "Unknown"

    # Replace problematic characters
    # Windows: \ / : * ? " < > |
    # Also replace other potentially problematic chars
    sanitized = re.sub(r'[\\/:*?"<>|]', '_', name)

    # Replace multiple spaces/underscores with single
    sanitized = re.sub(r'[_\s]+', ' ', sanitized)

    # Strip leading/trailing whitespace and dots (Windows issue)
    sanitized = sanitized.strip(' .')

    # Truncate if too long
    if len(sanitized) > max_length:
        sanitized = sanitized[:max_length].strip(' .')

    # Fallback if empty after sanitization
    if not sanitized:
        return "Unknown"

    return sanitized


def get_file_path_for_track(artist: str, name: str, format: str = "flac") -> Path:
    """Get the file path for a track based on artist and song name.

    Structure: /app/library/tracks/Artist Name/Song Name.flac
    """
    ensure_library_dir()

    safe_artist = sanitize_filename(artist or "Unknown Artist")
    safe_name = sanitize_filename(name or "Unknown Track")

    artist_dir = LIBRARY_DIR / "tracks" / safe_artist
    artist_dir.mkdir(parents=True, exist_ok=True)

    return artist_dir / f"{safe_name}.{format}"


def get_file_path(isrc: str, format: str = "flac", metadata: Optional[Dict[str, Any]] = None) -> Path:
    """Get the file path for a track in the library.

    If metadata with artist/name is provided, uses artist/song structure.
    Otherwise falls back to ISRC-based naming.
    """
    if metadata and metadata.get("artist") and metadata.get("name"):
        return get_file_path_for_track(
            metadata["artist"],
            metadata["name"],
            format
        )

    # Fallback: use ISRC as filename in root tracks folder
    ensure_library_dir()
    tracks_dir = LIBRARY_DIR / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)

    safe_isrc = sanitize_filename(isrc)
    return tracks_dir / f"{safe_isrc}.{format}"


async def load_index() -> Dict[str, Any]:
    """Load the library index from disk."""
    ensure_library_dir()
    if not INDEX_FILE.exists():
        return {"tracks": {}, "version": 2, "created": datetime.utcnow().isoformat()}

    try:
        async with aiofiles.open(INDEX_FILE, 'r') as f:
            content = await f.read()
            return json.loads(content)
    except Exception as e:
        logger.error(f"Error loading library index: {e}")
        return {"tracks": {}, "version": 2, "created": datetime.utcnow().isoformat()}


async def save_index(index: Dict[str, Any]):
    """Save the library index to disk."""
    ensure_library_dir()
    try:
        async with aiofiles.open(INDEX_FILE, 'w') as f:
            await f.write(json.dumps(index, indent=2))
    except Exception as e:
        logger.error(f"Error saving library index: {e}")


async def get_track_file_path(isrc: str) -> Optional[Path]:
    """Get the actual file path for a track from the index."""
    index = await load_index()
    track_info = index.get("tracks", {}).get(isrc)

    if not track_info:
        return None

    # Get path from index
    rel_path = track_info.get("path")
    if rel_path:
        return LIBRARY_DIR / rel_path

    # Fallback: reconstruct from metadata
    return get_file_path(isrc, track_info.get("format", "flac"), track_info)


async def track_exists(isrc: str, format: str = "flac") -> bool:
    """Check if a track exists in the library."""
    index = await load_index()
    if isrc not in index.get("tracks", {}):
        return False

    file_path = await get_track_file_path(isrc)
    return file_path is not None and file_path.exists()


async def get_track_info(isrc: str) -> Optional[Dict[str, Any]]:
    """Get metadata for a track in the library."""
    index = await load_index()
    return index.get("tracks", {}).get(isrc)


async def add_track(
    isrc: str,
    data: bytes,
    format: str = "flac",
    metadata: Optional[Dict[str, Any]] = None
) -> bool:
    """Add a track to the library.

    Args:
        isrc: Track identifier
        data: Audio file bytes
        format: File format (flac, mp3, etc.)
        metadata: Optional track metadata (name, artist, album, etc.)

    Returns:
        True if successful, False otherwise
    """
    try:
        # Check storage limits
        if LIBRARY_MAX_SIZE_GB > 0:
            current_size = await get_library_size_gb()
            new_size = len(data) / (1024 * 1024 * 1024)
            if current_size + new_size > LIBRARY_MAX_SIZE_GB:
                logger.warning(f"Library storage limit exceeded ({LIBRARY_MAX_SIZE_GB} GB)")
                return False

        # Determine file path based on metadata
        file_path = get_file_path(isrc, format, metadata)

        # Write file
        async with aiofiles.open(file_path, 'wb') as f:
            await f.write(data)

        # Update index
        async with _index_lock:
            index = await load_index()
            index["tracks"][isrc] = {
                "format": format,
                "size": len(data),
                "added": datetime.utcnow().isoformat(),
                "path": str(file_path.relative_to(LIBRARY_DIR)),
                **(metadata or {})
            }
            index["updated"] = datetime.utcnow().isoformat()
            await save_index(index)

        artist = metadata.get("artist", "Unknown") if metadata else "Unknown"
        name = metadata.get("name", isrc) if metadata else isrc
        logger.info(f"Added to library: {artist} - {name} ({len(data) / 1024 / 1024:.2f} MB)")
        return True

    except Exception as e:
        logger.error(f"Error adding track to library: {e}")
        return False


async def delete_track(isrc: str) -> bool:
    """Remove a track from the library."""
    try:
        # Get track info first
        index = await load_index()
        track_info = index.get("tracks", {}).get(isrc)

        if not track_info:
            logger.warning(f"Track not in library index: {isrc}")
            return False

        # Get file path from index
        file_path = await get_track_file_path(isrc)
        if file_path and file_path.exists():
            file_path.unlink()
            logger.info(f"Deleted library file: {file_path}")

            # Try to remove empty artist directory
            try:
                artist_dir = file_path.parent
                if artist_dir != LIBRARY_DIR / "tracks" and not any(artist_dir.iterdir()):
                    artist_dir.rmdir()
                    logger.info(f"Removed empty artist directory: {artist_dir}")
            except Exception:
                pass

        # Update index
        async with _index_lock:
            index = await load_index()
            if isrc in index.get("tracks", {}):
                del index["tracks"][isrc]
                index["updated"] = datetime.utcnow().isoformat()
                await save_index(index)

        logger.info(f"Removed from library: {isrc}")
        return True

    except Exception as e:
        logger.error(f"Error deleting track from library: {e}")
        return False


async def list_tracks(
    offset: int = 0,
    limit: int = 50,
    sort_by: str = "added",
    sort_desc: bool = True
) -> Dict[str, Any]:
    """List tracks in the library with pagination.

    Returns:
        Dict with tracks list and total count
    """
    index = await load_index()
    tracks = index.get("tracks", {})

    # Convert to list with ISRCs
    track_list = [
        {"isrc": isrc, **info}
        for isrc, info in tracks.items()
    ]

    # Sort
    if sort_by in ["added", "name", "artist", "size"]:
        track_list.sort(
            key=lambda x: x.get(sort_by, ""),
            reverse=sort_desc
        )

    # Paginate
    total = len(track_list)
    paginated = track_list[offset:offset + limit]

    return {
        "tracks": paginated,
        "total": total,
        "offset": offset,
        "limit": limit
    }


async def check_multiple(isrcs: List[str]) -> Dict[str, bool]:
    """Check if multiple tracks exist in the library.

    Efficient batch check for displaying library badges.

    Args:
        isrcs: List of track identifiers

    Returns:
        Dict mapping ISRC to exists boolean
    """
    index = await load_index()
    tracks = index.get("tracks", {})

    result = {}
    for isrc in isrcs:
        if isrc in tracks:
            # Check file exists using path from index
            rel_path = tracks[isrc].get("path")
            if rel_path:
                file_path = LIBRARY_DIR / rel_path
                result[isrc] = file_path.exists()
            else:
                result[isrc] = False
        else:
            result[isrc] = False

    return result


async def get_library_size_gb() -> float:
    """Get total library size in GB."""
    ensure_library_dir()
    total = 0
    tracks_dir = LIBRARY_DIR / "tracks"

    if tracks_dir.exists():
        for root, dirs, files in os.walk(tracks_dir):
            for file in files:
                try:
                    total += os.path.getsize(os.path.join(root, file))
                except OSError:
                    pass

    return total / (1024 * 1024 * 1024)


async def get_stats() -> Dict[str, Any]:
    """Get library statistics."""
    index = await load_index()
    tracks = index.get("tracks", {})

    total_size = sum(t.get("size", 0) for t in tracks.values())

    # Count formats
    formats = {}
    artists = set()
    for track in tracks.values():
        fmt = track.get("format", "unknown")
        formats[fmt] = formats.get(fmt, 0) + 1
        if track.get("artist"):
            artists.add(track["artist"])

    return {
        "track_count": len(tracks),
        "artist_count": len(artists),
        "total_size_mb": round(total_size / (1024 * 1024), 2),
        "total_size_gb": round(total_size / (1024 * 1024 * 1024), 2),
        "formats": formats,
        "max_size_gb": LIBRARY_MAX_SIZE_GB if LIBRARY_MAX_SIZE_GB > 0 else None,
        "created": index.get("created"),
        "updated": index.get("updated")
    }


async def verify_index():
    """Verify index matches actual files, clean up orphaned entries."""
    async with _index_lock:
        index = await load_index()
        tracks = index.get("tracks", {})

        to_remove = []
        for isrc, info in tracks.items():
            rel_path = info.get("path")
            if rel_path:
                file_path = LIBRARY_DIR / rel_path
            else:
                file_path = get_file_path(isrc, info.get("format", "flac"), info)

            if not file_path.exists():
                logger.warning(f"Orphaned index entry (file missing): {isrc}")
                to_remove.append(isrc)

        if to_remove:
            for isrc in to_remove:
                del tracks[isrc]
            index["updated"] = datetime.utcnow().isoformat()
            await save_index(index)
            logger.info(f"Cleaned {len(to_remove)} orphaned entries from library index")

        return len(to_remove)
