/**
 * Freedify State Module
 * Global state, helpers, constants, and migration
 */

// ========== HELPERS ==========
export function safeLoad(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
}

export function enforceArrayCap(arr, max) {
    while (arr.length > max) arr.pop();
}

export const MAX_LIBRARY_SIZE = 2000;
export const MAX_HISTORY_SIZE = 200;

// ========== STATE ==========
export const state = {
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    searchType: 'track',
    detailTracks: [],  // Tracks in current detail view
    detailName: '',    // Name of current album/playlist for downloads
    detailArtist: '',  // Artist of current album for downloads
    detailReleaseYear: '',  // Release year for downloads
    detailCover: null,      // Album cover URL for downloads
    detailType: 'album',    // 'album' or 'playlist' for download logic
    repeatMode: 'none', // 'none' | 'all' | 'one'
    volume: parseFloat(localStorage.getItem('freedify_volume')) || 1,
    muted: false,
    crossfadeDuration: 1, // seconds (when crossfade is enabled)
    playlists: safeLoad('freedify_playlists', []),
    scrobbledCurrent: false, // Track if current song was scrobbled
    listenBrainzConfig: { valid: false, username: null }, // LB status
    hiResMode: localStorage.getItem('freedify_hires') !== 'false', // Hi-Res 24-bit mode (Default True)
    hiResQuality: localStorage.getItem('freedify_hires_quality') || '6', // '6'=96kHz/24bit, '5'=192kHz/24bit
    sortOrder: 'newest', // 'newest' or 'oldest' for album sorting
    lastSearchResults: [], // Store last search results for re-rendering
    lastSearchType: 'track', // Store last search type
    history: safeLoad('freedify_history', []),
    library: safeLoad('freedify_library', []),
    playbackSpeed: parseFloat(localStorage.getItem('freedify_playback_speed')) || 1.0, // Persists across reloads; applies to all audio
    preservesPitch: localStorage.getItem('freedify_preserves_pitch') !== 'false', // Default true
    sleepTimer: null, // { endsAt: number|null, endOfTrack: boolean, minutes: number|null }
    abRepeat: { a: null, b: null }, // Seconds; when both set, loops between them
    customAccent: localStorage.getItem('freedify_custom_accent') || '', // Optional user-picked accent color
    podcastFavorites: safeLoad('freedify_podcasts', []),
    audiobookFavorites: safeLoad('freedify_audiobooks', []),
    podcastPlayedEpisodes: safeLoad('freedify_podcast_played', {}),
    podcastResumePositions: safeLoad('freedify_podcast_resume', {}),
    podcastHistory: safeLoad('freedify_podcast_history', []),
    audiobookHistory: safeLoad('freedify_audiobook_history', []),
    podcastTags: safeLoad('freedify_podcast_tags', {}),
    lastSavedPositionTime: 0, // In-memory tracker for resume saves
    watchedPlaylists: safeLoad('freedify_watched', []),
    currentMood: safeLoad('freedify_current_mood', null),
    moodHistory: safeLoad('freedify_mood_history', []),
    moodPreferences: safeLoad('freedify_mood_preferences', {
        Focus: { liked: [], disliked: [] },
        Workout: { liked: [], disliked: [] },
        Chill: { liked: [], disliked: [] },
        Party: { liked: [], disliked: [] },
        "Late Night": { liked: [], disliked: [] },
        Commute: { liked: [], disliked: [] }
    }),
    syncEnabled: safeLoad('freedify_sync_enabled', false),
    syncRole: safeLoad('freedify_sync_role', 'player'), // 'player' or 'remote'
    syncConnectedDevices: [],
    syncLastAppliedTimestamp: 0,
};

// One-time migration: move audiobook entries from podcastHistory to audiobookHistory
(function migrateAudiobookHistory() {
    const audiobooks = state.podcastHistory.filter(e => e.source === 'audiobook');
    if (audiobooks.length > 0) {
        // Move audiobook entries to audiobookHistory (avoid duplicates)
        const existingIds = new Set(state.audiobookHistory.map(e => e.id));
        audiobooks.forEach(e => { if (!existingIds.has(e.id)) state.audiobookHistory.push(e); });
        state.podcastHistory = state.podcastHistory.filter(e => e.source !== 'audiobook');
        localStorage.setItem('freedify_podcast_history', JSON.stringify(state.podcastHistory));
        localStorage.setItem('freedify_audiobook_history', JSON.stringify(state.audiobookHistory));
    }
})();

// One-time migration: initialize all three mood keys if absent
(function initMoodDefaults() {
    if (!localStorage.getItem('freedify_mood_preferences')) {
        localStorage.setItem('freedify_mood_preferences', JSON.stringify({
            Focus: { liked: [], disliked: [] },
            Workout: { liked: [], disliked: [] },
            Chill: { liked: [], disliked: [] },
            Party: { liked: [], disliked: [] },
            "Late Night": { liked: [], disliked: [] },
            Commute: { liked: [], disliked: [] }
        }));
    }
    if (!localStorage.getItem('freedify_mood_history')) {
        localStorage.setItem('freedify_mood_history', JSON.stringify([]));
    }
    if (!localStorage.getItem('freedify_current_mood')) {
        localStorage.setItem('freedify_current_mood', JSON.stringify(null));
    }

    // Validate moodPreferences structure — show toast on corruption per spec
    try {
        const prefs = JSON.parse(localStorage.getItem('freedify_mood_preferences'));
        if (typeof prefs !== 'object' || prefs === null || !prefs.Focus) {
            throw new Error('invalid structure');
        }
    } catch {
        localStorage.setItem('freedify_mood_preferences', JSON.stringify({
            Focus: { liked: [], disliked: [] },
            Workout: { liked: [], disliked: [] },
            Chill: { liked: [], disliked: [] },
            Party: { liked: [], disliked: [] },
            "Late Night": { liked: [], disliked: [] },
            Commute: { liked: [], disliked: [] }
        }));
        // Deferred toast — state.js runs before DOM is ready, so schedule for after load
        window.addEventListener('DOMContentLoaded', () => {
            if (typeof showToast === 'function') {
                showToast('Mood preferences reset. Your profile will rebuild over time.');
            }
        }, { once: true });
    }
})();
