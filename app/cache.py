"""
Cache service for storing transcoded audio files.
Implements auto-cleanup to stay within storage limits.
"""
import os
import time
import asyncio
import aiofiles
from pathlib import Path
from typing import Optional
import logging

logger = logging.getLogger(__name__)

import json
import re
import shutil

# ---- Persisted settings (cap, library mode, library folder) ----
# Kept beside the app (NOT inside CACHE_DIR, which cleanup would delete), alongside
# freedify_settings.json.
_CONFIG_FILE = Path(__file__).resolve().parent.parent / "freedify_cache_config.json"
# ISRC -> relative library path index (so replays find organized files instantly).
_LIBRARY_INDEX_FILE = Path(__file__).resolve().parent.parent / "freedify_library_index.json"


def _load_config() -> dict:
    """Read the whole settings dict (cap + library mode + folder) from disk."""
    try:
        if _CONFIG_FILE.exists():
            with open(_CONFIG_FILE, "r") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
    except Exception as e:
        logger.warning(f"Could not read cache config ({_CONFIG_FILE}): {e}")
    return {}


def _save_config(updates: dict):
    """Merge updates into the persisted settings dict (never clobbers other keys)."""
    cfg = _load_config()
    cfg.update(updates)
    try:
        with open(_CONFIG_FILE, "w") as f:
            json.dump(cfg, f)
    except Exception as e:
        logger.error(f"Failed to persist cache config: {e}")


# ---- Cache / library root folder ----
# Resolution order: user-selected folder (persisted) > CACHE_DIR env var > default
# home folder. Changeable at runtime via set_cache_dir() (Settings > Storage).
# Use home directory for better cross-platform compatibility (works on Termux/Android).
_default_cache = os.path.join(os.path.expanduser("~"), ".freedify_cache")


def _load_cache_dir() -> Path:
    saved = _load_config().get("library_folder")
    if saved:
        try:
            return Path(saved)
        except Exception:
            pass
    return Path(os.environ.get("CACHE_DIR", _default_cache))


CACHE_DIR = _load_cache_dir()
CACHE_TTL_HOURS = int(os.environ.get("CACHE_TTL_HOURS", "24"))

# Minimum cache cap the user is allowed to set (MB). Smaller than this isn't useful
# once tracks are full FLAC files (~30-45 MB each).
MIN_CACHE_SIZE_MB = 500
# Default cap (MB) — 2 GB. Overridable by env var and, at runtime, by the user via
# the Settings UI (persisted to _CONFIG_FILE). The user-set value takes precedence.
DEFAULT_CACHE_SIZE_MB = int(os.environ.get("MAX_CACHE_SIZE_MB", "2048"))
# Default for Library mode (organized, permanent collection). Off unless opted in.
DEFAULT_LIBRARY_MODE = os.environ.get("LIBRARY_MODE", "false").lower() in ("1", "true", "yes")


def _load_max_cache_size_mb() -> int:
    """Resolve the active cap: user-saved value if present, else env/default. Floored at MIN."""
    value = _load_config().get("max_cache_size_mb")
    if not isinstance(value, (int, float)) or value <= 0:
        value = DEFAULT_CACHE_SIZE_MB
    return max(MIN_CACHE_SIZE_MB, int(value))


# Active cap (MB), mutable at runtime via set_max_cache_size_mb().
MAX_CACHE_SIZE_MB = _load_max_cache_size_mb()
# Active Library mode flag, mutable at runtime via set_library_mode().
_library_mode = _load_config().get("library_mode")
LIBRARY_MODE = bool(_library_mode) if isinstance(_library_mode, bool) else DEFAULT_LIBRARY_MODE


def get_max_cache_size_mb() -> int:
    """Current cache cap in MB."""
    return MAX_CACHE_SIZE_MB


def set_max_cache_size_mb(mb: int) -> int:
    """Set and persist the cache cap (MB). Enforces the MIN floor; no upper bound."""
    global MAX_CACHE_SIZE_MB
    applied = max(MIN_CACHE_SIZE_MB, int(mb))
    MAX_CACHE_SIZE_MB = applied
    _save_config({"max_cache_size_mb": applied})
    logger.info(f"Cache cap set to {applied} MB")
    return applied


def get_library_mode() -> bool:
    """Whether organized, permanent Library mode is enabled."""
    return LIBRARY_MODE


def set_library_mode(enabled: bool) -> bool:
    """Enable/disable Library mode and persist it."""
    global LIBRARY_MODE
    LIBRARY_MODE = bool(enabled)
    _save_config({"library_mode": LIBRARY_MODE})
    logger.info(f"Library mode {'enabled' if LIBRARY_MODE else 'disabled'}")
    return LIBRARY_MODE


def get_cache_dir() -> str:
    """Absolute path of the current cache / library root folder."""
    return str(CACHE_DIR)


def validate_cache_dir(path: str) -> Optional[str]:
    """Validate a candidate folder. Returns an error string, or None if OK.

    Creates the folder if it doesn't exist and verifies it's writable.
    """
    if not path or not str(path).strip():
        return "No folder path provided"
    try:
        p = Path(path).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        # Verify writability with a temp probe file
        probe = p / ".freedify_write_test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return None
    except Exception as e:
        return f"Folder is not usable: {e}"


def set_cache_dir(path: str) -> Path:
    """Switch the cache/library root to a new folder and persist it.

    Does NOT move existing files — call move_library() first if the user opted in.
    """
    global CACHE_DIR
    new_dir = Path(path).expanduser()
    new_dir.mkdir(parents=True, exist_ok=True)
    CACHE_DIR = new_dir
    _save_config({"library_folder": str(new_dir)})
    logger.info(f"Cache/library folder set to: {new_dir}")
    return CACHE_DIR


def move_library(new_path: str) -> dict:
    """Move everything in the current CACHE_DIR into new_path (merge-aware), then
    return a summary. Used when the user changes the library folder and opts to
    bring their existing collection along.

    Merges into an existing target: each file keeps its relative Artist/Album path,
    so the library index (relative paths) stays valid against the new root.
    """
    src = CACHE_DIR
    dst = Path(new_path).expanduser()
    dst.mkdir(parents=True, exist_ok=True)

    if src.resolve() == dst.resolve():
        return {"moved": 0, "skipped": 0, "freed_from_source": True}

    moved = 0
    skipped = 0
    for item in src.rglob("*"):
        if not item.is_file():
            continue
        rel = item.relative_to(src)
        target = dst / rel
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                # Already present at destination — drop the source copy
                item.unlink()
                skipped += 1
            else:
                shutil.move(str(item), str(target))
                moved += 1
        except Exception as e:
            logger.error(f"Move failed for {rel}: {e}")
    # Remove now-empty source subdirectories (deepest first), but keep src root
    for d in sorted([p for p in src.rglob("*") if p.is_dir()], key=lambda p: len(p.parts), reverse=True):
        try:
            d.rmdir()
        except OSError:
            pass  # not empty / in use — leave it
    logger.info(f"Moved library: {moved} files ({skipped} already existed) {src} -> {dst}")
    return {"moved": moved, "skipped": skipped}


# ============================================================
# LIBRARY MODE — organized, permanent collection
#   Layout: CACHE_DIR/<Artist>/<Album> (Year)/<NN - Title>.flac
#   Files live in subfolders, so cleanup_cache()/clear_cache() (which only scan
#   top-level files) never touch them — the library is permanent by construction.
# ============================================================

# Characters not allowed in Windows/most filesystem names, plus control chars.
_ILLEGAL_FS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _sanitize_component(name: str, fallback: str) -> str:
    """Make a string safe to use as a single path component."""
    if not name:
        return fallback
    cleaned = _ILLEGAL_FS.sub("", str(name)).strip()
    # Windows disallows trailing dots/spaces on names
    cleaned = cleaned.rstrip(". ")
    # Keep components to a sane length to avoid MAX_PATH issues
    if len(cleaned) > 120:
        cleaned = cleaned[:120].rstrip(". ")
    return cleaned or fallback


def library_path_for(metadata: dict) -> Optional[Path]:
    """Build the organized library path from track metadata, or None if metadata is insufficient."""
    if not metadata:
        return None
    title = (metadata.get("title") or "").strip()
    album = (metadata.get("album") or "").strip()
    artists = (metadata.get("artists") or "").strip()
    # Require at least an artist and a title to organize meaningfully
    if not title or not artists:
        return None

    artist_folder = _sanitize_component(artists.split(",")[0].strip(), "Unknown Artist")

    year = ""
    raw_year = metadata.get("year")
    if raw_year:
        y = str(raw_year)[:4]
        if y.isdigit():
            year = y
    album_name = _sanitize_component(album or "Unknown Album", "Unknown Album")
    album_folder = f"{album_name} ({year})" if year else album_name

    title_safe = _sanitize_component(title, "Unknown Title")
    track_no = metadata.get("track_number")
    try:
        track_no = int(track_no) if track_no else None
    except (ValueError, TypeError):
        track_no = None
    filename = f"{track_no:02d} - {title_safe}.flac" if track_no else f"{title_safe}.flac"

    return CACHE_DIR / artist_folder / album_folder / filename


def _load_library_index() -> dict:
    try:
        if _LIBRARY_INDEX_FILE.exists():
            with open(_LIBRARY_INDEX_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
    except Exception as e:
        logger.warning(f"Could not read library index: {e}")
    return {}


def _save_library_index(index: dict):
    try:
        with open(_LIBRARY_INDEX_FILE, "w", encoding="utf-8") as f:
            json.dump(index, f)
    except Exception as e:
        logger.error(f"Failed to persist library index: {e}")


def find_in_library(isrc: str) -> Optional[Path]:
    """Return the organized file path for an ISRC if it's already in the library."""
    index = _load_library_index()
    rel = index.get(isrc)
    if not rel:
        return None
    path = CACHE_DIR / rel
    if path.exists() and path.stat().st_size > 0:
        return path
    # Stale entry — drop it
    index.pop(isrc, None)
    _save_library_index(index)
    return None


async def save_to_library(isrc: str, data: bytes, metadata: dict) -> Optional[Path]:
    """Write a (already-tagged) FLAC into the organized library and index it by ISRC.

    Returns the path on success, or None if metadata was insufficient / write failed
    (caller should fall back to the flat cache).
    """
    path = library_path_for(metadata)
    if not path:
        return None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(path, "wb") as f:
            await f.write(data)
        index = _load_library_index()
        index[isrc] = str(path.relative_to(CACHE_DIR))
        _save_library_index(index)
        logger.info(f"Saved to library: {path.relative_to(CACHE_DIR)} ({len(data)/1024/1024:.1f} MB)")
        return path
    except Exception as e:
        logger.error(f"Failed to save to library for {isrc}: {e}")
        return None


def get_library_stats() -> dict:
    """Recursive size/count of the organized library (files in Artist/Album subfolders)."""
    ensure_cache_dir()
    total = 0
    count = 0
    try:
        for f in CACHE_DIR.rglob("*.flac"):
            # Only count files inside subfolders (the library), not flat cache files
            if f.is_file() and f.parent != CACHE_DIR:
                total += f.stat().st_size
                count += 1
    except Exception as e:
        logger.warning(f"Library stats scan error: {e}")
    return {"track_count": count, "size_mb": round(total / 1024 / 1024, 1)}


def get_cache_stats() -> dict:
    """Return cache usage/limits plus library mode + library size (for the Settings UI)."""
    ensure_cache_dir()
    # Flat (ephemeral) cache: top-level files only
    files = [f for f in CACHE_DIR.iterdir() if f.is_file()]
    used_bytes = sum(f.stat().st_size for f in files)
    lib = get_library_stats()
    return {
        "used_mb": round(used_bytes / 1024 / 1024, 1),
        "max_mb": MAX_CACHE_SIZE_MB,
        "min_mb": MIN_CACHE_SIZE_MB,
        "ttl_hours": CACHE_TTL_HOURS,
        "file_count": len(files),
        "library_mode": LIBRARY_MODE,
        "library_track_count": lib["track_count"],
        "library_size_mb": lib["size_mb"],
        "cache_dir": str(CACHE_DIR),
    }


def clear_cache() -> dict:
    """Delete every ephemeral cache file (top-level only).

    Does NOT touch the organized library in Artist/Album subfolders — iterdir() is
    non-recursive, so a user's permanent collection is never cleared by this.
    """
    ensure_cache_dir()
    removed = 0
    freed = 0
    for f in list(CACHE_DIR.iterdir()):
        if f.is_file():
            try:
                freed += f.stat().st_size
                f.unlink()
                removed += 1
            except Exception as e:
                logger.error(f"Error clearing cache file {f.name}: {e}")
    logger.info(f"Cleared cache: {removed} files, {freed / 1024 / 1024:.1f} MB freed")
    return {"removed": removed, "freed_mb": round(freed / 1024 / 1024, 1)}


def ensure_cache_dir():
    """Ensure cache directory exists."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR


def get_cache_path(isrc: str, format: str = "mp3") -> Path:
    """Get the cache file path for a given ISRC.
    
    For LINK: prefixed IDs (which can be very long base64 strings),
    we hash the ID to create a shorter, valid filename.
    """
    import hashlib
    ensure_cache_dir()
    
    # Hash long IDs to prevent "filename too long" errors
    if len(isrc) > 100 or isrc.startswith("LINK:"):
        safe_name = hashlib.md5(isrc.encode()).hexdigest()
    else:
        # Sanitize the ISRC for use as filename
        safe_name = isrc.replace("/", "_").replace(":", "_")
    
    return CACHE_DIR / f"{safe_name}.{format}"


def is_cached(isrc: str, format: str = "mp3") -> bool:
    """Check if a track is cached."""
    cache_path = get_cache_path(isrc, format)
    return cache_path.exists() and cache_path.stat().st_size > 0


async def get_cached_file(isrc: str, format: str = "mp3") -> Optional[bytes]:
    """Retrieve a cached file if it exists."""
    cache_path = get_cache_path(isrc, format)
    if cache_path.exists():
        try:
            # Update access time
            cache_path.touch()
            async with aiofiles.open(cache_path, 'rb') as f:
                return await f.read()
        except Exception as e:
            logger.error(f"Error reading cache for {isrc}: {e}")
    return None


async def cache_file(isrc: str, data: bytes, format: str = "mp3") -> bool:
    """Cache a transcoded file."""
    try:
        cache_path = get_cache_path(isrc, format)
        async with aiofiles.open(cache_path, 'wb') as f:
            await f.write(data)
        logger.info(f"Cached {isrc}.{format} ({len(data) / 1024 / 1024:.2f} MB)")
        return True
    except Exception as e:
        logger.error(f"Error caching {isrc}: {e}")
        return False


def get_cache_size_mb() -> float:
    """Get total cache size in MB."""
    ensure_cache_dir()
    total = sum(f.stat().st_size for f in CACHE_DIR.iterdir() if f.is_file())
    return total / 1024 / 1024


async def cleanup_cache():
    """Remove old files to stay within cache limits."""
    ensure_cache_dir()
    now = time.time()
    ttl_seconds = CACHE_TTL_HOURS * 3600
    max_bytes = get_max_cache_size_mb() * 1024 * 1024
    
    files = []
    for f in CACHE_DIR.iterdir():
        if f.is_file():
            stat = f.stat()
            files.append({
                'path': f,
                'size': stat.st_size,
                'atime': stat.st_atime
            })
    
    # Remove files older than TTL
    for file_info in files[:]:
        if now - file_info['atime'] > ttl_seconds:
            try:
                file_info['path'].unlink()
                files.remove(file_info)
                logger.info(f"Removed expired cache file: {file_info['path'].name}")
            except Exception as e:
                logger.error(f"Error removing {file_info['path']}: {e}")
    
    # If still over limit, remove oldest files
    files.sort(key=lambda x: x['atime'])
    total_size = sum(f['size'] for f in files)
    
    while total_size > max_bytes and files:
        oldest = files.pop(0)
        try:
            oldest['path'].unlink()
            total_size -= oldest['size']
            logger.info(f"Removed cache file to free space: {oldest['path'].name}")
        except Exception as e:
            logger.error(f"Error removing {oldest['path']}: {e}")
    
    logger.info(f"Cache size after cleanup: {total_size / 1024 / 1024:.2f} MB")


async def periodic_cleanup(interval_minutes: int = 30):
    """Run cache cleanup periodically."""
    while True:
        await asyncio.sleep(interval_minutes * 60)
        await cleanup_cache()
