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

# Cache configuration
CACHE_DIR = Path(os.environ.get("CACHE_DIR", "/tmp/spotiflac_cache"))
MAX_CACHE_SIZE_MB = int(os.environ.get("MAX_CACHE_SIZE_MB", "500"))
CACHE_TTL_HOURS = int(os.environ.get("CACHE_TTL_HOURS", "24"))


def ensure_cache_dir():
    """Ensure cache directory exists."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR


def get_cache_path(isrc: str, format: str = "mp3") -> Path:
    """Get the cache file path for a given ISRC."""
    ensure_cache_dir()
    return CACHE_DIR / f"{isrc}.{format}"


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
    max_bytes = MAX_CACHE_SIZE_MB * 1024 * 1024
    
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
