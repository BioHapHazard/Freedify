"""
Qobuz Service
Retrieves lossless and Hi-Res audio via multiple Qobuz proxy endpoints.
No authentication required.

Quality codes:
  27 = Hi-Res FLAC 24-bit / 192kHz
  7 = Hi-Res FLAC 24-bit / 96kHz
  6 = FLAC 16-bit / 44.1kHz (CD quality)
  5 = MP3 320kbps
"""
import httpx
import logging
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

QOBUZ_SQUID_API = "https://qobuz.squid.wtf/api"
QOBUZ_APP_ID = "798273057"

QOBUZ_STREAM_ENDPOINTS = [
    {"url": "https://eu.qobuz.squid.wtf/api/download-music", "param": "track_id"},
    {"url": "https://us.qobuz.squid.wtf/api/download-music", "param": "track_id"},
    {"url": "https://qobuz.squid.wtf/api/download-music", "param": "track_id"},
    {"url": "https://dab.yeet.su/api/stream", "param": "trackId"},
    {"url": "https://dabmusic.xyz/api/stream", "param": "trackId"},
]


class QobuzService:
    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=20.0,
            follow_redirects=True,
            headers={"User-Agent": "Freedify/1.5.0"}
        )

    async def search_tracks(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search tracks on Qobuz — tries direct API first, then squid.wtf proxy."""
        results = await self._search_qobuz_direct(query, limit)
        if results:
            return results
        return await self._search_squid_proxy(query, limit)

    async def _search_qobuz_direct(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Search via Qobuz public API (works for ISRC and text queries)."""
        try:
            resp = await self.client.get(
                "https://www.qobuz.com/api.json/0.2/track/search",
                params={"query": query, "limit": limit, "app_id": QOBUZ_APP_ID}
            )
            if resp.status_code != 200:
                logger.warning(f"Qobuz direct search returned {resp.status_code}")
                return []

            data = resp.json()
            items = data.get("tracks", {}).get("items", [])
            return [self._format_track(t) for t in items if isinstance(t, dict)]
        except Exception as e:
            logger.error(f"Qobuz direct search error: {e}")
            return []

    async def _search_squid_proxy(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Fallback: search via squid.wtf proxy."""
        try:
            resp = await self.client.get(
                f"{QOBUZ_SQUID_API}/get-music",
                params={"q": query, "offset": 0, "limit": limit}
            )
            if resp.status_code != 200:
                logger.warning(f"Qobuz squid search returned {resp.status_code}")
                return []

            text = resp.text
            if not text:
                return []

            try:
                data = resp.json()
            except Exception as je:
                logger.error(f"Qobuz squid search JSON parse error: {je}")
                return []

            if not data.get("success") or not data.get("data"):
                return []

            tracks_data = data["data"].get("tracks", {})
            items = tracks_data.get("items", [])
            return [self._format_track(t) for t in items if isinstance(t, dict)]

        except Exception as e:
            logger.error(f"Qobuz squid search error: {e}")
            return []

    async def search_albums(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search albums on Qobuz — tries direct API first, then squid.wtf proxy."""
        results = await self._search_albums_direct(query, limit)
        if results:
            return results
        return await self._search_albums_squid(query, limit)

    async def _search_albums_direct(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Search albums via Qobuz public API."""
        try:
            resp = await self.client.get(
                "https://www.qobuz.com/api.json/0.2/album/search",
                params={"query": query, "limit": limit, "app_id": QOBUZ_APP_ID}
            )
            if resp.status_code != 200:
                return []

            data = resp.json()
            items = data.get("albums", {}).get("items", [])
            return [self._format_album(t) for t in items if isinstance(t, dict)]
        except Exception as e:
            logger.error(f"Qobuz direct album search error: {e}")
            return []

    async def _search_albums_squid(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Fallback: search albums via squid.wtf proxy."""
        try:
            resp = await self.client.get(
                f"{QOBUZ_SQUID_API}/get-music",
                params={"q": query, "offset": 0, "limit": limit}
            )
            if resp.status_code != 200:
                return []

            data = resp.json()
            if not data.get("success") or not data.get("data"):
                return []

            albums_data = data["data"].get("albums", {})
            items = albums_data.get("items", [])
            return [self._format_album(t) for t in items if isinstance(t, dict)]
        except Exception as e:
            logger.error(f"Qobuz squid album search error: {e}")
            return []

    def _format_album(self, item: dict) -> dict:
        """Format Qobuz album to Freedify schema."""
        artist_obj = item.get("artist") or {}
        artist_name = artist_obj.get("name") if isinstance(artist_obj, dict) else str(artist_obj)

        image = item.get("image", {})
        cover = image.get("large") if isinstance(image, dict) else None

        return {
            "id": f"qobuz_{item.get('id')}",
            "type": "album",
            "name": item.get("title", ""),
            "artists": artist_name,
            "album_art": cover,
            "release_date": item.get("release_date", ""),
            "total_tracks": item.get("tracks_count", 0),
            "source": "qobuz",
            "is_hi_res": item.get("hires", False) or item.get("hires_streamable", False),
            "audio_quality": {
                "isHiRes": item.get("hires", False) or item.get("hires_streamable", False)
            }
        }

    def _format_track(self, item: dict, album_override: dict = None) -> dict:
        """Format Qobuz track to Freedify schema."""
        performer = item.get("performer") or item.get("artist") or {}
        if isinstance(performer, dict):
            artist_name = performer.get("name", "Unknown Artist")
        else:
            artist_name = str(performer) if performer else "Unknown Artist"

        album = item.get("album", album_override or {})
        album_title = album.get("title", "") if isinstance(album, dict) else ""

        album_art = None
        if isinstance(album, dict):
            image = album.get("image", {})
            if isinstance(image, dict):
                album_art = image.get("large") or image.get("small") or image.get("thumbnail")

        return {
            "id": f"qobuz_{item.get('id')}",
            "type": "track",
            "name": item.get("title", "Unknown"),
            "artists": artist_name,
            "album": album_title,
            "album_art": album_art,
            "duration_ms": (item.get("duration", 0)) * 1000,
            "duration": f"{item.get('duration', 0) // 60}:{item.get('duration', 0) % 60:02d}",
            "isrc": item.get("isrc"),
            "release_date": album.get("released_at", "") if isinstance(album, dict) else "",
            "source": "qobuz",
            "is_hi_res": item.get("hires", False) or item.get("hires_streamable", False),
        }

    async def get_stream_url(self, track_id: str, quality: str = "6") -> Optional[str]:
        """
        Get stream URL by trying multiple Qobuz proxy endpoints sequentially.

        Quality codes:
            27 = Hi-Res 192kHz/24-bit
            7 = Hi-Res 96kHz/24-bit
            6 = FLAC 16-bit / 44.1kHz (CD quality) — default
            5 = MP3 320kbps
        """
        clean_id = str(track_id).replace("qobuz_", "")

        for ep in QOBUZ_STREAM_ENDPOINTS:
            try:
                resp = await self.client.get(
                    ep["url"],
                    params={ep["param"]: clean_id, "quality": quality},
                    timeout=60.0
                )
                if resp.status_code != 200:
                    logger.warning(f"Qobuz stream endpoint {ep['url']} returned {resp.status_code}")
                    continue

                data = resp.json()

                url = None
                if data.get("url"):
                    url = data["url"]
                elif data.get("data", {}).get("url"):
                    url = data["data"]["url"]
                elif data.get("success") and data.get("data", {}).get("url"):
                    url = data["data"]["url"]

                if url:
                    logger.info(f"Qobuz stream URL from {ep['url']}: {url[:50]}...")
                    return url

                logger.warning(f"Qobuz endpoint {ep['url']} returned no URL in response")
            except Exception as e:
                logger.error(f"Qobuz stream error from {ep['url']}: {e}")
                continue

        logger.error("All Qobuz stream endpoints failed")
        return None

    async def get_album(self, album_id: str) -> Optional[Dict[str, Any]]:
        """Fetch album with tracks by Qobuz album ID."""
        clean_id = str(album_id).replace("qobuz_", "")
        try:
            resp = await self.client.get(
                "https://www.qobuz.com/api.json/0.2/album/get",
                params={"album_id": clean_id, "app_id": QOBUZ_APP_ID}
            )
            if resp.status_code != 200:
                logger.warning(f"Qobuz album fetch returned {resp.status_code}")
                return None

            data = resp.json()
            if not data.get("id"):
                return None

            album = self._format_album(data)
            raw_tracks = data.get("tracks", {}).get("items", [])
            album["tracks"] = [self._format_track(t, album_override=data) for t in raw_tracks if isinstance(t, dict)]
            return album
        except Exception as e:
            logger.error(f"Qobuz get_album error: {e}")
            return None

    async def search_by_isrc(self, isrc: str) -> Optional[Dict[str, Any]]:
        """Search for a specific track by ISRC via Qobuz direct API."""
        try:
            resp = await self.client.get(
                "https://www.qobuz.com/api.json/0.2/track/search",
                params={"query": isrc, "limit": 1, "app_id": QOBUZ_APP_ID}
            )
            if resp.status_code != 200:
                return None

            data = resp.json()
            items = data.get("tracks", {}).get("items", [])
            if items:
                return self._format_track(items[0])
            return None
        except Exception as e:
            logger.error(f"Qobuz ISRC search error: {e}")
            return None

    async def close(self):
        await self.client.aclose()


# Singleton
qobuz_service = QobuzService()
