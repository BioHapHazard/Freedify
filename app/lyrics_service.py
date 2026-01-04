from fastapi import Response
import logging

logger = logging.getLogger(__name__)

class LyricsService:
    """Service for fetching lyrics."""

    API_URL = "https://lrclib.net/api/get"
    SEARCH_URL = "https://lrclib.net/api/search"

    def __init__(self):
        import httpx
        self.client = httpx.AsyncClient(timeout=10.0)

    async def get_lyrics(self, track_name: str, artist_name: str, duration: float = None, album_name: str = None):
        """
        Fetch lyrics from LRCLIB.
        """
        try:
            params = {
                "track_name": track_name,
                "artist_name": artist_name,
            }
            if duration:
                params["duration"] = duration
            if album_name:
                params["album_name"] = album_name

            response = await self.client.get(self.API_URL, params=params)

            if response.status_code == 200:
                return response.json()
            elif response.status_code == 404:
                # Try search if direct match fails
                return await self.search_lyrics(track_name, artist_name)
            return None
        except Exception as e:
            logger.error(f"Lyrics fetch error: {e}")
            return None

    async def search_lyrics(self, track_name: str, artist_name: str):
        try:
            params = {
                "q": f"{track_name} {artist_name}"
            }
            response = await self.client.get(self.SEARCH_URL, params=params)
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    return data[0] # Return first match
            return None
        except Exception as e:
            logger.error(f"Lyrics search error: {e}")
            return None

    async def close(self):
        await self.client.aclose()

lyrics_service = LyricsService()
