"""
Setlist.fm service for Freedify.
Searches for concert setlists and matches them to audio sources (Phish.in, Archive.org).
"""
import os
import httpx
from typing import Optional, Dict, List, Any
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

# API key from environment
SETLIST_FM_API_KEY = os.getenv("SETLIST_FM_API_KEY", "")


class SetlistService:
    """Service for searching and retrieving concert setlists from Setlist.fm."""
    
    API_BASE = "https://api.setlist.fm/rest/1.0"
    
    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=15.0,
            headers={
                "Accept": "application/json",
                "x-api-key": SETLIST_FM_API_KEY
            }
        )
    
    async def search_setlists(self, query: str, page: int = 1) -> List[Dict[str, Any]]:
        """Search for setlists by artist name or date.
        
        Examples:
            "Grateful Dead" - search by artist
            "Phish 2023" - artist + year
            "Pearl Jam 1991-09-20" - specific date
        """
        if not SETLIST_FM_API_KEY:
            logger.warning("Setlist.fm API key not configured")
            return []
        
        try:
            # Parse query for artist and potential date
            # Parse query for artist and potential date
            params = {"p": page}
            
            # Helper to strip date parts from query to get artist name
            def clean_query(q, match_str):
                return q.replace(match_str, "").strip()

            import re
            
            # Pattern 1: YYYY-MM-DD
            date_match_iso = re.search(r'(\d{4})-(\d{2})-(\d{2})', query)
            
            # Pattern 2: DD-MM-YYYY (what user tried)
            date_match_eu = re.search(r'(\d{2})-(\d{2})-(\d{4})', query)
            
            # Pattern 3: Month name and day
            month_match = re.search(r'(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s*(\d{4})?', query)
            
            # Pattern 4: Simple year
            year_match = re.search(r'\b(19|20)\d{2}\b', query)
            
            if date_match_iso:
                # YYYY-MM-DD -> API needs dd-MM-yyyy
                dt = datetime.strptime(date_match_iso.group(0), "%Y-%m-%d")
                params["date"] = dt.strftime("%d-%m-%Y")
                params["artistName"] = clean_query(query, date_match_iso.group(0))
                
            elif date_match_eu:
                # DD-MM-YYYY -> API needs dd-MM-yyyy (pass as is, or reformat to ensure validity)
                # User typed: 31-12-2025
                try:
                    dt = datetime.strptime(date_match_eu.group(0), "%d-%m-%Y")
                    params["date"] = dt.strftime("%d-%m-%Y")
                    params["artistName"] = clean_query(query, date_match_eu.group(0))
                except ValueError:
                    # Invalid date (e.g. 99-99-2025), fallback to year or artist
                    logger.warning(f"Invalid date in query: {date_match_eu.group(0)}")
                    if year_match:
                         params["year"] = year_match.group(0)
                         params["artistName"] = clean_query(query, year_match.group(0))
                    else:
                        params["artistName"] = query

            elif month_match:
                # Month Day [Year]
                try:
                    month_str = month_match.group(1)
                    day_str = month_match.group(2)
                    year_str = month_match.group(3)
                    
                    # Convert month name to number
                    dt_str = f"{month_str} {day_str} {year_str if year_str else '2000'}" # Dummy year if missing
                    dt = datetime.strptime(dt_str, "%b %d %Y")
                    
                    if year_str:
                        # Full date found
                        params["date"] = dt.strftime("%d-%m-%Y")
                    else:
                        # Recursive search or just month param? Setlist API only supports full date or year
                        # If year is missing in "Phish December 31", we might need to guess current year or search by year
                        # For now, let's assume current year if user says "Phish December 31"
                        current_year = datetime.now().year
                        params["date"] = dt.strftime(f"%d-%m-{current_year}")
                    
                    params["artistName"] = clean_query(query, month_match.group(0))
                except Exception as e:
                    logger.warning(f"Date parse error: {e}")
                    # Fallback to year only if possible
                    if year_match:
                        params["year"] = year_match.group(0)
                        params["artistName"] = clean_query(query, year_match.group(0))
                    else:
                        params["artistName"] = query

            elif year_match:
                # Year only
                params["year"] = year_match.group(0)
                params["artistName"] = clean_query(query, year_match.group(0))
                
            else:
                # Just artist name
                params["artistName"] = query
            
            logger.info(f"Searching Setlist.fm: {params}")
            response = await self.client.get(f"{self.API_BASE}/search/setlists", params=params)
            
            if response.status_code == 404:
                return []
            
            response.raise_for_status()
            data = response.json()
            
            setlists = data.get("setlist", [])
            return [self._format_setlist(s) for s in setlists[:20]]
            
        except Exception as e:
            logger.error(f"Setlist.fm search error: {e}")
            return []
    
    async def get_setlist(self, setlist_id: str) -> Optional[Dict[str, Any]]:
        """Get full setlist details by ID."""
        if not SETLIST_FM_API_KEY:
            return None
        
        try:
            response = await self.client.get(f"{self.API_BASE}/setlist/{setlist_id}")
            
            if response.status_code != 200:
                return None
            
            data = response.json()
            return self._format_setlist_detail(data)
            
        except Exception as e:
            logger.error(f"Setlist.fm get_setlist error: {e}")
            return None
    
    def _format_setlist(self, item: dict) -> dict:
        """Format setlist data for search results."""
        artist = item.get("artist", {})
        venue = item.get("venue", {})
        city = venue.get("city", {})
        
        # Parse date (format: DD-MM-YYYY)
        event_date = item.get("eventDate", "")
        formatted_date = ""
        iso_date = ""
        if event_date:
            try:
                dt = datetime.strptime(event_date, "%d-%m-%Y")
                formatted_date = dt.strftime("%B %d, %Y")
                iso_date = dt.strftime("%Y-%m-%d")
            except:
                formatted_date = event_date
        
        # Count songs
        song_count = 0
        for setlist_set in item.get("sets", {}).get("set", []):
            song_count += len(setlist_set.get("song", []))
        
        return {
            "id": f"setlist_{item.get('id', '')}",
            "type": "setlist",
            "name": f"{artist.get('name', 'Unknown')} at {venue.get('name', 'Unknown Venue')}",
            "artists": artist.get("name", ""),
            "artist_mbid": artist.get("mbid", ""),
            "venue": venue.get("name", ""),
            "city": f"{city.get('name', '')}, {city.get('stateCode', '')} {city.get('country', {}).get('code', '')}".strip(", "),
            "date": formatted_date,
            "iso_date": iso_date,
            "song_count": song_count,
            "setlist_id": item.get("id", ""),
            "url": item.get("url", ""),
            "source": "setlist.fm",
            # For display
            "album_art": "/static/icon.svg",  # Use default icon
            "total_tracks": song_count,
            "release_date": iso_date,
        }
    
    def _format_setlist_detail(self, item: dict) -> dict:
        """Format full setlist with all songs."""
        base = self._format_setlist(item)
        
        # Extract all songs from all sets
        tracks = []
        set_idx = 0
        for setlist_set in item.get("sets", {}).get("set", []):
            set_name = setlist_set.get("name") or f"Set {set_idx + 1}"
            if setlist_set.get("encore"):
                set_name = "Encore"
            
            for song in setlist_set.get("song", []):
                song_name = song.get("name", "Unknown")
                
                # Build track info
                track = {
                    "id": f"setlist_song_{base['setlist_id']}_{len(tracks)}",
                    "name": song_name,
                    "artists": base["artists"],
                    "set_name": set_name,
                    "with_info": song.get("with", {}).get("name"),  # Guest artist
                    "cover_info": song.get("cover", {}).get("name"),  # Original artist if cover
                    "info": song.get("info", ""),  # Additional notes
                    "duration": "",  # Setlist.fm doesn't have duration
                    "type": "track",
                    "source": "setlist.fm",
                }
                tracks.append(track)
            
            set_idx += 1
        
        base["tracks"] = tracks
        base["type"] = "album"  # Treat as album for detail view
        
        # Determine audio source
        artist_lower = base["artists"].lower()
        if "phish" in artist_lower:
            base["audio_source"] = "phish.in"
            base["audio_url"] = f"https://phish.in/{base['iso_date']}"
        else:
            base["audio_source"] = "archive.org"
            # We'll set audio_url after searching for the best version
            base["audio_search"] = f"{base['artists']} {base['iso_date']}"
        
        return base
    
    async def find_best_archive_show(self, artist: str, iso_date: str) -> Optional[str]:
        """Search Archive.org for the best (most downloaded) version of a show."""
        try:
            # Map common artist names to Archive.org collections
            artist_lower = artist.lower()
            collection = None
            
            collection_map = {
                "grateful dead": "GratefulDead",
                "dead": "GratefulDead",
                "billy strings": "BillyStrings",
                "ween": "Ween",
                "king gizzard": "KingGizzardAndTheLizardWizard",
                "kglw": "KingGizzardAndTheLizardWizard",
            }
            
            for key, val in collection_map.items():
                if key in artist_lower:
                    collection = val
                    break
            
            if not collection:
                # Fallback: search by creator
                query = f'creator:"{artist}" AND date:{iso_date}* AND mediatype:etree'
            else:
                query = f'collection:{collection} AND date:{iso_date}* AND mediatype:etree'
            
            params = {
                "q": query,
                "fl[]": ["identifier", "downloads"],
                "sort[]": "downloads desc",  # Sort by most downloads
                "rows": 1,  # Just get the top one
                "output": "json",
            }
            
            response = await self.client.get("https://archive.org/advancedsearch.php", params=params)
            if response.status_code != 200:
                return None
            
            data = response.json()
            docs = data.get("response", {}).get("docs", [])
            
            if docs:
                identifier = docs[0].get("identifier")
                return f"https://archive.org/details/{identifier}"
            
            return None
            
        except Exception as e:
            logger.error(f"Archive.org search error: {e}")
            return None
    
    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()


# Singleton instance
setlist_service = SetlistService()
