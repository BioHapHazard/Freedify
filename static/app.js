/**
 * Freedify - Music Streaming PWA
 * Enhanced search with albums, artists, playlists, and Spotify URL support
 */

console.log('🔥 FREEDIFY APP.JS VERSION: 2026-01-21-STRICT-MODE-V2 🔥');

// ========== STATE ==========
const state = {
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
    playlists: JSON.parse(localStorage.getItem('freedify_playlists') || '[]'), // User playlists
    scrobbledCurrent: false, // Track if current song was scrobbled
    listenBrainzConfig: { valid: false, username: null }, // LB status
    hiResMode: localStorage.getItem('freedify_hires') !== 'false', // Hi-Res 24-bit mode (Default True)
    hiResQuality: localStorage.getItem('freedify_hires_quality') || '6', // '6'=96kHz/24bit, '5'=192kHz/24bit
    sortOrder: 'newest', // 'newest' or 'oldest' for album sorting
    lastSearchResults: [], // Store last search results for re-rendering
    lastSearchType: 'track', // Store last search type
    history: JSON.parse(localStorage.getItem('freedify_history') || '[]'), // Listening history (last 50)
    library: JSON.parse(localStorage.getItem('freedify_library') || '[]'), // Saved/starred tracks
    playbackSpeed: 1.0, // Default playback speed for podcasts
    podcastFavorites: JSON.parse(localStorage.getItem('freedify_podcasts') || '[]'), // Favorited podcasts
    audiobookFavorites: JSON.parse(localStorage.getItem('freedify_audiobooks') || '[]'), // Favorited books
    podcastPlayedEpisodes: JSON.parse(localStorage.getItem('freedify_podcast_played') || '{}'), // {episodeId: true}
    podcastResumePositions: JSON.parse(localStorage.getItem('freedify_podcast_resume') || '{}'), // {episodeId: seconds}
    podcastHistory: JSON.parse(localStorage.getItem('freedify_podcast_history') || '[]'), // Recently played episodes
    audiobookHistory: JSON.parse(localStorage.getItem('freedify_audiobook_history') || '[]'), // Recently played audiobook chapters
    podcastTags: JSON.parse(localStorage.getItem('freedify_podcast_tags') || '{}'), // {podcastId: ['tag1','tag2']}
    lastSavedPositionTime: 0 // In-memory tracker for resume saves
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

// ========== iOS AUDIO KEEPALIVE ==========
// iOS Safari aggressively suspends web audio on screen lock.
// This silent audio context helps keep the audio engine alive.
let iosAudioContext = null;
let iosKeepAliveStarted = false;

function startIOSAudioKeepAlive() {
    if (iosKeepAliveStarted) return;
    
    try {
        // Create a silent AudioContext
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        
        iosAudioContext = new AudioContext();
        
        // Create a silent oscillator (inaudible frequency)
        const oscillator = iosAudioContext.createOscillator();
        const gainNode = iosAudioContext.createGain();
        
        // Set volume to 0 (silent)
        gainNode.gain.value = 0;
        
        // Use a very low frequency (essentially silent)
        oscillator.frequency.value = 1;
        oscillator.type = 'sine';
        
        // Connect: oscillator -> gain (muted) -> output
        oscillator.connect(gainNode);
        gainNode.connect(iosAudioContext.destination);
        
        // Start the silent oscillator
        oscillator.start();
        
        iosKeepAliveStarted = true;
        console.log('iOS audio keepalive started');
        
        // Resume context on visibility change (iOS sometimes suspends it)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && iosAudioContext?.state === 'suspended') {
                iosAudioContext.resume();
            }
        });
    } catch (e) {
        console.log('iOS audio keepalive not available:', e.message);
    }
}

// Start keepalive on first user interaction (required by iOS)
document.addEventListener('click', () => startIOSAudioKeepAlive(), { once: true });
document.addEventListener('touchstart', () => startIOSAudioKeepAlive(), { once: true });

// ========== DOM ELEMENTS ==========
// App.js v0106L - Robust Proxy Cleanup
console.log("Freedify v0106L Loaded - Robust Proxy Cleanup");

// Helper for multiple selectors (Fix for ReferenceError: $$ is not defined)
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// Global Image Error Handler - Fallback to placeholder for broken album art
document.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG' && e.target.src && !e.target.src.includes('placeholder.svg') && !e.target.dataset.errorHandled) {
        console.log('Image failed to load, using placeholder:', e.target.src);
        e.target.dataset.errorHandled = 'true';  // Prevent infinite retry
        e.target.src = '/static/placeholder.svg';
    }
}, true); // Use capture phase to catch before bubbling

// Global Event Delegation for Detail Tracks (Fixes click issues)
document.addEventListener('click', (e) => {
    // Check if click is inside detail-tracks
    const trackItem = e.target.closest('#detail-tracks .track-item');
    if (!trackItem) return;
    
    // Don't play if clicking buttons (including star button)
    if (e.target.closest('.download-btn') || e.target.closest('.delete-track-btn') || e.target.closest('.info-btn') || e.target.closest('.star-btn')) return;
    
    const index = parseInt(trackItem.dataset.index, 10);
    if (isNaN(index)) return;
    
    // Auto-queue logic
    const sourceTracks = (state.detailTracks && state.detailTracks.length > 0) ? state.detailTracks : [];
    
    if (sourceTracks.length === 0) return;
    
    // Don't auto-queue podcast episodes - let user view details and explicitly play
    const clickedTrack = sourceTracks[index];
    if (clickedTrack && clickedTrack.source === 'podcast') {
        // Show the podcast modal instead of queuing
        showPodcastModal(encodeURIComponent(JSON.stringify(clickedTrack)));
        return;
    }
    
    const remainingTracks = sourceTracks.slice(index);
    
    state.queue = remainingTracks;
    state.currentIndex = 0;
    
    showToast(`Queueing ${remainingTracks.length} tracks...`);
    
    updateQueueUI();
    
    // Check if this track is already preloaded - use it instantly!
    if (preloadedTrackId === clickedTrack.id && preloadedReady && preloadedPlayer) {
        console.log('Using preloaded track (detail click):', clickedTrack.name);
        preloadedTrackId = null;
        preloadedReady = false;
        updatePlayerUI();
        updateFullscreenUI(clickedTrack);
        performGaplessSwitch();
        updateFormatBadge(getActivePlayer().src);
        setTimeout(preloadNextTrack, 500);
    } else {
        loadTrack(clickedTrack);
    }
});

// Global Event Delegation for Star (Library) Buttons
document.addEventListener('click', (e) => {
    const starBtn = e.target.closest('.star-btn');
    if (!starBtn) return;
    
    e.stopPropagation();
    const trackId = starBtn.dataset.trackId;
    if (!trackId) return;
    
    // Find track data from wherever we can
    let track = state.history.find(t => t.id === trackId) 
             || state.library.find(t => t.id === trackId)
             || state.detailTracks.find(t => t.id === trackId)
             || state.queue.find(t => t.id === trackId)
             || state.lastSearchResults.find(t => t.id === trackId);
    
    if (!track) {
        // Try to get from the track item's data attributes
        const trackItem = starBtn.closest('.track-item');
        if (trackItem) {
            const nameEl = trackItem.querySelector('.track-name');
            const artistEl = trackItem.querySelector('.track-artist');
            const artEl = trackItem.querySelector('.track-album-art');
            track = {
                id: trackId,
                name: nameEl?.textContent || 'Unknown',
                artists: artistEl?.textContent || '',
                album_art: artEl?.src || '/static/icon.svg',
                isrc: trackId
            };
        }
    }
    
    if (track) {
        const nowStarred = toggleLibrary(track);
        starBtn.textContent = nowStarred ? '★' : '☆';
        starBtn.classList.toggle('starred', nowStarred);
        starBtn.title = nowStarred ? 'Remove from Library' : 'Add to Library';
    }
});

const searchInput = $('#search-input');
const searchClear = $('#search-clear');
const typeBtns = $$('.type-btn');
const resultsSection = $('#results-section');
const resultsContainer = $('#results-container');
const detailView = $('#detail-view');
const detailInfo = $('#detail-info');
const detailTracks = $('#detail-tracks');
const backBtn = $('#back-btn');
const queueAllBtn = $('#queue-all-btn');
const shuffleBtn = $('#shuffle-btn');
const queueSection = $('#queue-section');
const queueContainer = $('#queue-container');
const queueClose = $('#queue-close');
const queueClear = $('#queue-clear');
const queueCount = $('#queue-count');
const queueBtn = $('#queue-btn');

// Back button: exit detail view and return to results
backBtn?.addEventListener('click', () => {
    detailView.classList.add('hidden');
    resultsSection.classList.remove('hidden');
    // Clear playlist view tracking
    state.currentPlaylistView = null;
});

// Add All to Queue button in detail view
queueAllBtn?.addEventListener('click', () => {
    const tracks = state.detailTracks || [];
    if (tracks.length === 0) {
        showToast('No tracks to add');
        return;
    }
    // Append all tracks to the current queue
    tracks.forEach(t => {
        if (!state.queue.some(q => q.id === t.id)) {
            state.queue.push(t);
        }
    });
    updateQueueUI();
    showToast(`Added ${tracks.length} tracks to queue`);
});

// Shuffle & Play button in detail view
shuffleBtn?.addEventListener('click', () => {
    const tracks = state.detailTracks || [];
    if (tracks.length === 0) {
        showToast('No tracks to shuffle');
        return;
    }
    // Shuffle using Fisher-Yates
    const shuffled = [...tracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    state.queue = shuffled;
    state.currentIndex = 0;
    updateQueueUI();
    loadTrack(shuffled[0]);
    showToast(`Shuffling ${shuffled.length} tracks`);
});

// Fullscreen Elements
const fsToggleBtn = $('#fs-toggle-btn');
const fullscreenPlayer = $('#fullscreen-player');
const fsCloseBtn = $('#fs-close-btn');
const fsArt = $('#fs-art');
const fsTitle = $('#fs-title');
const fsArtist = $('#fs-artist');
const fsCurrentTime = $('#fs-current-time');
const fsDuration = $('#fs-duration');
const fsProgressBar = $('#fs-progress-bar');
const fsPlayBtn = $('#fs-play-btn');
const fsPrevBtn = $('#fs-prev-btn');
const fsNextBtn = $('#fs-next-btn');
const loadingOverlay = $('#loading-overlay');
const loadingText = $('#loading-text');
const errorMessage = $('#error-message');
const errorText = $('#error-text');
const errorRetry = $('#error-retry');
const playerBar = $('#player-bar');
const playerArt = $('#player-art');
const playerTitle = $('#player-title');
const playerArtist = $('#player-artist');
const playerAlbum = $('#player-album');
const playerYear = $('#player-year');
const playBtn = $('#play-btn');
const prevBtn = $('#prev-btn');
const nextBtn = $('#next-btn');
const shuffleQueueBtn = $('#shuffle-queue-btn');
const repeatBtn = $('#repeat-btn');
const progressBar = $('#progress-bar');
const currentTime = $('#current-time');
const duration = $('#duration');
const audioPlayer = $('#audio-player');
const audioPlayer2 = $('#audio-player-2');
const miniPlayerBtn = $('#mini-player-btn');
let pipWindow = null;

// Crossfade / Gapless state
let activePlayer = 1; // 1 or 2, which player is currently active
let crossfadeEnabled = localStorage.getItem('freedify_crossfade') === 'true';
let CROSSFADE_DURATION = 1000; // Default: 1 second. Options: 500, 1000, 2000
let crossfadeTimeout = null;
let preloadedPlayer = null; // Ready player with next track loaded
let preloadedReady = false; // True when preloaded track has fired canplaythrough

// Volume Controls
const volumeSlider = $('#volume-slider');
const muteBtn = $('#mute-btn');

// Toast & Shortcuts
const toastContainer = $('#toast-container');
const shortcutsHelp = $('#shortcuts-help');
const shortcutsClose = $('#shortcuts-close');

// ========== SEARCH ==========
let searchTimeout = null;
// Debounced search with 500ms delay after user stops typing

searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();

    // Clear any existing timeout
    if (searchTimeout) {
        clearTimeout(searchTimeout);
    }

    if (!query) {
        // Clear empty state when input is empty
        showEmptyState();
        return;
    }

    // Set new timeout for debounced search
    searchTimeout = setTimeout(() => {
        performSearch(query, false, true); // debounced search - no loading overlay
        searchTimeout = null;
    }, 500);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        // Clear any pending debounced search
        if (searchTimeout) {
            clearTimeout(searchTimeout);
            searchTimeout = null;
        }
        const query = searchInput.value.trim();
        if (query) {
            performSearch(query);
        }
        searchInput.blur();
    }
});

searchClear.addEventListener('click', () => {
    searchInput.value = '';
    showEmptyState();
    searchInput.focus();
});

const searchMoreBtn = $('#search-more-btn');
const searchMoreMenu = $('#search-more-menu');

// Toggle Search More Menu
if (searchMoreBtn) {
    searchMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        searchMoreMenu.classList.toggle('hidden');
    });
}

// Close menu when clicking elsewhere
document.addEventListener('click', (e) => {
    if (searchMoreMenu && !searchMoreMenu.contains(e.target) && e.target !== searchMoreBtn) {
        searchMoreMenu.classList.add('hidden');
    }
});

// Search type selector
// Re-select all type buttons including new menu items
const allTypeBtns = document.querySelectorAll('.type-btn, .type-btn-menu');

allTypeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.id === 'search-more-btn') return; // Skip the toggle button itself
        
        allTypeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // If it's a menu item, highlight the "More" button too as a visual indicator
        if (btn.classList.contains('type-btn-menu')) {
            searchMoreBtn.classList.add('active');
            searchMoreMenu.classList.add('hidden'); // Close menu on selection
        }

        state.searchType = btn.dataset.type;
        
        // Special types
        if (state.searchType === 'favorites') {
            renderPlaylistsView();
            return;
        } else if (state.searchType === 'rec') {
            renderRecommendations();
            return;
        } else if (state.searchType === 'podcast') {
            const query = searchInput.value.trim();
            if (query) {
                performSearch(query);
            } else {
                renderMyPodcastsView();
            }
            return;
        } else if (state.searchType === 'audiobook') {
            const query = searchInput.value.trim();
            if (query) {
                performSearch(query);
            } else {
                renderMyBooksView();
            }
            return;
        }
        
        const query = searchInput.value.trim();
        if (query) {
            performSearch(query);
        } else {
            // Show Jump Back In dashboard when switching to music search types
            showEmptyState();
        }
    });
});

// Sort Filter Removed

// Crossfade Toggle
const crossfadeCheckbox = $('#crossfade-checkbox');
if (crossfadeCheckbox) {
    // Initialize from state
    crossfadeCheckbox.checked = state.crossfadeEnabled;
    
    crossfadeCheckbox.addEventListener('change', () => {
        state.crossfadeEnabled = crossfadeCheckbox.checked;
        localStorage.setItem('freedify_crossfade', state.crossfadeEnabled);
        showToast(state.crossfadeEnabled ? 'Crossfade enabled' : 'Crossfade disabled');
    });
}

// ========== PLAYLIST MANAGEMENT ==========
function savePlaylists() {
    localStorage.setItem('freedify_playlists', JSON.stringify(state.playlists));
}

function createPlaylist(name, tracks = []) {
    const playlist = {
        id: 'playlist_' + Date.now(),
        name: name,
        created: new Date().toISOString(),
        tracks: tracks.map(t => ({
            id: t.id,
            name: t.name,
            artists: t.artists,
            album: t.album || '',
            album_art: t.album_art || t.image || '/static/icon.svg',
            isrc: t.isrc || t.id,
            duration: t.duration || '0:00'
        }))
    };
    state.playlists.push(playlist);
    savePlaylists();
    showToast(`Created playlist "${name}"`);
    return playlist;
}

function addToPlaylist(playlistId, trackOrTracks) {
    const playlist = state.playlists.find(p => p.id === playlistId);
    if (!playlist) return;
    
    const tracksToAdd = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
    let addedCount = 0;
    
    tracksToAdd.forEach(track => {
        // Avoid duplicates
        if (playlist.tracks.some(t => t.id === track.id)) return;
        
        playlist.tracks.push({
            id: track.id,
            name: track.name,
            artists: track.artists,
            album: track.album || '',
            album_art: track.album_art || track.image || '/static/icon.svg',
            isrc: track.isrc || track.id,
            duration: track.duration || '0:00'
        });
        addedCount++;
    });
    
    if (addedCount > 0) {
        savePlaylists();
        showToast(`Added ${addedCount} tracks to "${playlist.name}"`);
    } else {
        showToast('Tracks already in playlist');
    }
}

function deleteFromPlaylist(playlistId, trackId) {
    const playlist = state.playlists.find(p => p.id === playlistId);
    if (!playlist) return;
    
    const idx = playlist.tracks.findIndex(t => t.id === trackId);
    if (idx !== -1) {
        playlist.tracks.splice(idx, 1);
        savePlaylists();
        showToast('Track removed');
        // Refresh view if currently viewing this playlist
        if (state.currentPlaylistView === playlistId) {
            showPlaylistDetail(playlist);
        }
    }
}

// Expose for use in detail view
window.deleteFromPlaylist = deleteFromPlaylist;

function deletePlaylist(playlistId) {
    state.playlists = state.playlists.filter(p => p.id !== playlistId);
    savePlaylists();
    showToast('Playlist deleted');
    renderPlaylistsView();
}

// ========== LISTENING HISTORY ==========
function saveHistory() {
    localStorage.setItem('freedify_history', JSON.stringify(state.history));
}

function addToHistory(track) {
    if (!track || !track.id) return;
    
    const historyEntry = {
        id: track.id,
        name: track.name,
        artists: track.artists,
        album: track.album || '',
        album_art: track.album_art || track.image || '/static/icon.svg',
        isrc: track.isrc || track.id,
        duration: track.duration || '0:00',
        listenedAt: Date.now(),
        source: track.source || 'youtube'
    };
    
    // Remove existing entry for same track (to move it to top)
    state.history = state.history.filter(h => h.id !== track.id);
    
    // Add to beginning
    state.history.unshift(historyEntry);
    
    // Limit to 50 entries
    if (state.history.length > 50) {
        state.history = state.history.slice(0, 50);
    }
    
    saveHistory();
}

// ========== MY LIBRARY (STARRED TRACKS) ==========
function saveLibrary() {
    localStorage.setItem('freedify_library', JSON.stringify(state.library));
}

function addToLibrary(track) {
    if (!track || !track.id) return false;
    
    // Check if already in library
    if (state.library.some(t => t.id === track.id)) {
        return false; // Already exists
    }
    
    const libraryEntry = {
        id: track.id,
        name: track.name,
        artists: track.artists,
        album: track.album || '',
        album_art: track.album_art || track.image || '/static/icon.svg',
        isrc: track.isrc || track.id,
        duration: track.duration || '0:00',
        addedAt: Date.now(),
        source: track.source || 'youtube'
    };
    
    state.library.unshift(libraryEntry);
    saveLibrary();
    showToast(`★ Added "${track.name}" to Library`);
    return true;
}

function removeFromLibrary(trackId) {
    const idx = state.library.findIndex(t => t.id === trackId);
    if (idx !== -1) {
        const track = state.library[idx];
        state.library.splice(idx, 1);
        saveLibrary();
        showToast(`Removed "${track.name}" from Library`);
        return true;
    }
    return false;
}

function isInLibrary(trackId) {
    return state.library.some(t => t.id === trackId);
}

function toggleLibrary(track) {
    if (isInLibrary(track.id)) {
        removeFromLibrary(track.id);
        return false;
    } else {
        addToLibrary(track);
        return true;
    }
}

function addAllToLibrary(tracks) {
    if (!tracks || tracks.length === 0) {
        showToast('No tracks to add');
        return 0;
    }
    
    let addedCount = 0;
    tracks.forEach(track => {
        if (track && track.id && !isInLibrary(track.id)) {
            // Add without individual toasts
            const libraryEntry = {
                id: track.id,
                name: track.name,
                artists: track.artists,
                album: track.album || '',
                album_art: track.album_art || track.image || '/static/icon.svg',
                isrc: track.isrc || track.id,
                duration: track.duration || '0:00',
                addedAt: Date.now(),
                source: track.source || 'youtube'
            };
            state.library.unshift(libraryEntry);
            addedCount++;
        }
    });
    
    if (addedCount > 0) {
        saveLibrary();
        showToast(`★ Added ${addedCount} of ${tracks.length} tracks to Library`);
    } else {
        showToast('All tracks already in Library');
    }
    return addedCount;
}

// Expose for use in UI
window.toggleLibrary = toggleLibrary;
window.isInLibrary = isInLibrary;
window.addAllToLibrary = addAllToLibrary;

// ========== PODCAST FAVORITES ==========
function savePodcastFavorites() {
    localStorage.setItem('freedify_podcasts', JSON.stringify(state.podcastFavorites));
}

function addPodcastFavorite(podcast) {
    if (!podcast || !podcast.id) return false;
    if (state.podcastFavorites.some(p => p.id === podcast.id)) return false;
    
    state.podcastFavorites.unshift({
        id: podcast.id,
        name: podcast.name,
        artist: podcast.artists || podcast.artist || '',
        artwork: podcast.album_art || podcast.artwork || '/static/icon.svg',
        addedAt: Date.now(),
        tags: []
    });
    savePodcastFavorites();
    showToast(`❤️ Saved "${podcast.name}" to My Podcasts`);
    return true;
}

function removePodcastFavorite(podcastId) {
    const idx = state.podcastFavorites.findIndex(p => p.id === podcastId);
    if (idx !== -1) {
        const podcast = state.podcastFavorites[idx];
        state.podcastFavorites.splice(idx, 1);
        savePodcastFavorites();
        showToast(`Removed "${podcast.name}" from My Podcasts`);
        return true;
    }
    return false;
}

function isPodcastFavorited(podcastId) {
    return state.podcastFavorites.some(p => p.id === podcastId);
}

function togglePodcastFavorite(podcast) {
    if (isPodcastFavorited(podcast.id)) {
        removePodcastFavorite(podcast.id);
        return false;
    } else {
        addPodcastFavorite(podcast);
        return true;
    }
}

window.togglePodcastFavorite = togglePodcastFavorite;

// ========== AUDIOBOOK FAVORITES ==========
function saveAudiobookFavorites() {
    localStorage.setItem('freedify_audiobooks', JSON.stringify(state.audiobookFavorites));
}

function addAudiobookFavorite(book) {
    if (!book || !book.id) return false;
    if (state.audiobookFavorites.some(b => b.id === book.id)) return false;
    
    state.audiobookFavorites.unshift({
        id: book.id,
        name: book.name || book.title,
        artist: book.artists || book.artist || 'AudiobookBay',
        artwork: book.album_art || book.cover_image || book.artwork || '/static/icon.svg',
        addedAt: Date.now()
    });
    saveAudiobookFavorites();
    showToast(`❤️ Saved "${book.name || book.title}" to My Books`);
    return true;
}

function removeAudiobookFavorite(bookId) {
    const idx = state.audiobookFavorites.findIndex(b => b.id === bookId);
    if (idx !== -1) {
        const book = state.audiobookFavorites[idx];
        state.audiobookFavorites.splice(idx, 1);
        saveAudiobookFavorites();
        showToast(`Removed "${book.name}" from My Books`);
        return true;
    }
    return false;
}

function isAudiobookFavorited(bookId) {
    return state.audiobookFavorites.some(b => b.id === bookId);
}

function toggleAudiobookFavorite(book) {
    if (isAudiobookFavorited(book.id)) {
        removeAudiobookFavorite(book.id);
        return false;
    } else {
        addAudiobookFavorite(book);
        return true;
    }
}

window.toggleAudiobookFavorite = toggleAudiobookFavorite;
window.isPodcastFavorited = isPodcastFavorited;

// ========== PODCAST EPISODE TRACKING ==========
function savePodcastPlayed() {
    localStorage.setItem('freedify_podcast_played', JSON.stringify(state.podcastPlayedEpisodes));
}

function markEpisodePlayed(episodeId) {
    state.podcastPlayedEpisodes[episodeId] = true;
    savePodcastPlayed();
}

function markEpisodeUnplayed(episodeId) {
    delete state.podcastPlayedEpisodes[episodeId];
    savePodcastPlayed();
}

function isEpisodePlayed(episodeId) {
    return !!state.podcastPlayedEpisodes[episodeId];
}

function toggleEpisodePlayed(episodeId) {
    if (isEpisodePlayed(episodeId)) {
        markEpisodeUnplayed(episodeId);
        return false;
    } else {
        markEpisodePlayed(episodeId);
        return true;
    }
}

window.toggleEpisodePlayed = toggleEpisodePlayed;
window.isEpisodePlayed = isEpisodePlayed;

// ========== PODCAST RESUME POSITIONS ==========
function savePodcastResumePositions() {
    localStorage.setItem('freedify_podcast_resume', JSON.stringify(state.podcastResumePositions));
}

function saveEpisodePosition(episodeId, seconds) {
    if (seconds > 5) { // Only save if >5 seconds in
        state.podcastResumePositions[episodeId] = Math.floor(seconds);
        savePodcastResumePositions();
    }
}

function getEpisodePosition(episodeId) {
    return state.podcastResumePositions[episodeId] || 0;
}

function clearEpisodePosition(episodeId) {
    delete state.podcastResumePositions[episodeId];
    savePodcastResumePositions();
}

// ========== PODCAST HISTORY ==========
function savePodcastHistory() {
    localStorage.setItem('freedify_podcast_history', JSON.stringify(state.podcastHistory));
}

function addToPodcastHistory(episode) {
    if (!episode || !episode.id) return;
    // Remove existing entry if present
    state.podcastHistory = state.podcastHistory.filter(e => e.id !== episode.id);
    state.podcastHistory.unshift({
        id: episode.id,
        name: episode.name,
        artists: episode.artists || '',
        album_art: episode.album_art || '/static/icon.svg',
        duration: episode.duration || '0:00',
        playedAt: Date.now(),
        source: episode.source || 'podcast'
    });
    // Keep last 50
    if (state.podcastHistory.length > 50) state.podcastHistory = state.podcastHistory.slice(0, 50);
    savePodcastHistory();
}

// ========== AUDIOBOOK HISTORY ==========
function saveAudiobookHistory() {
    localStorage.setItem('freedify_audiobook_history', JSON.stringify(state.audiobookHistory));
}

function addToAudiobookHistory(episode) {
    if (!episode || !episode.id) return;
    // Remove existing entry if present
    state.audiobookHistory = state.audiobookHistory.filter(e => e.id !== episode.id);
    state.audiobookHistory.unshift({
        id: episode.id,
        name: episode.name,
        artists: episode.artists || '',
        album_art: episode.album_art || '/static/icon.svg',
        duration: episode.duration || '0:00',
        url: episode.url || '',
        src: episode.src || '',
        is_local: episode.is_local || false,
        track_number: episode.track_number || '',
        playedAt: Date.now(),
        source: episode.source || 'audiobook'
    });
    // Keep last 50
    if (state.audiobookHistory.length > 50) state.audiobookHistory = state.audiobookHistory.slice(0, 50);
    saveAudiobookHistory();
}

// ========== PODCAST TAGS ==========
function savePodcastTags() {
    localStorage.setItem('freedify_podcast_tags', JSON.stringify(state.podcastTags));
}

function setPodcastTags(podcastId, tags) {
    state.podcastTags[podcastId] = tags;
    savePodcastTags();
    // Also update the favorite entry
    const fav = state.podcastFavorites.find(p => p.id === podcastId);
    if (fav) {
        fav.tags = tags;
        savePodcastFavorites();
    }
}

function getPodcastTags(podcastId) {
    return state.podcastTags[podcastId] || [];
}

function getAllUsedTags() {
    const tags = new Set();
    Object.values(state.podcastTags).forEach(arr => arr.forEach(t => tags.add(t)));
    return [...tags].sort();
}

window.setPodcastTags = setPodcastTags;
window.getPodcastTags = getPodcastTags;

function renderPlaylistsView() {
    hideLoading();
    
    if (state.playlists.length === 0) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">❤️</span>
                <p>No saved playlists yet</p>
                <p style="font-size: 0.9em; opacity: 0.7;">Import a Spotify playlist and click "Save to Playlist"</p>
            </div>
        `;
        return;
    }
    
    const grid = document.createElement('div');
    grid.className = 'results-grid';
    
    state.playlists.forEach(playlist => {
        const trackCount = playlist.tracks.length;
        const coverArt = playlist.tracks[0]?.album_art || '/static/icon.svg';
        grid.innerHTML += `
            <div class="album-item playlist-item" data-playlist-id="${playlist.id}">
                <div class="album-art-container">
                    <img src="${coverArt}" alt="${playlist.name}" class="album-art" loading="lazy">
                    <div class="album-overlay">
                        <button class="play-album-btn">▶</button>
                    </div>
                </div>
                <div class="album-info">
                    <div class="album-name">${playlist.name}</div>
                    <div class="album-artist">${trackCount} track${trackCount !== 1 ? 's' : ''}</div>
                </div>
                <button class="delete-playlist-btn" title="Delete playlist">🗑️</button>
            </div>
        `;
    });
    
    const headerHtml = `
        <div class="playlists-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <h2>Your Playlists</h2>
            <div class="playlists-actions">
                <button id="import-playlist-btn" class="btn-secondary" style="padding: 8px 16px;">📥 Import Playlist</button>
                <input type="file" id="playlist-import-input" accept=".m3u,.m3u8,.csv,.json" class="hidden">
            </div>
        </div>
    `;
    
    resultsContainer.innerHTML = headerHtml;
    resultsContainer.appendChild(grid);
    
    // Bind import button
    const importBtn = document.getElementById('import-playlist-btn');
    const importInput = document.getElementById('playlist-import-input');
    
    if (importBtn && importInput) {
        importBtn.addEventListener('click', () => importInput.click());
        importInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handlePlaylistImport(file);
            e.target.value = ''; // Reset input
        });
    }
    
    // Click handlers
    grid.querySelectorAll('.playlist-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.delete-playlist-btn')) {
                e.stopPropagation();
                const id = el.dataset.playlistId;
                if (confirm('Delete this playlist?')) {
                    deletePlaylist(id);
                }
                return;
            }
            const playlist = state.playlists.find(p => p.id === el.dataset.playlistId);
            if (playlist) {
                showPlaylistDetail(playlist);
            }
        });
    });
}

// ========== MY PODCASTS PAGE ==========
function renderMyPodcastsView() {
    hideLoading();
    detailView.classList.add('hidden');
    resultsSection.classList.remove('hidden');
    
    if (state.podcastFavorites.length === 0) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">🎙️</span>
                <p>No saved podcasts yet</p>
                <p style="font-size: 0.9em; opacity: 0.7;">Search for podcasts and tap ❤️ to save them here</p>
                <button onclick="document.getElementById('search-input').focus(); document.getElementById('search-input').placeholder='Search podcasts...';" class="btn-secondary" style="margin-top: 12px; padding: 8px 20px;">🔍 Search Podcasts</button>
            </div>
        `;
        return;
    }
    
    // Build tag filter bar
    const allTags = getAllUsedTags();
    let tagFilterHtml = '';
    if (allTags.length > 0) {
        tagFilterHtml = `
            <div class="podcast-tag-filter" style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;">
                <button class="podcast-tag-btn active" data-tag="all">All</button>
                ${allTags.map(tag => `<button class="podcast-tag-btn" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}
            </div>
        `;
    }
    
    const headerHtml = `
        <div class="playlists-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h2>🎙️ My Podcasts</h2>
        </div>
        ${tagFilterHtml}
    `;
    
    const grid = document.createElement('div');
    grid.className = 'results-grid';
    grid.id = 'my-podcasts-grid';
    
    state.podcastFavorites.forEach(podcast => {
        const tags = getPodcastTags(podcast.id);
        const tagStr = tags.length > 0 ? tags.join(', ') : '';
        grid.innerHTML += `
            <div class="album-item podcast-fav-item" data-podcast-id="${podcast.id}" data-tags="${escapeHtml(tags.join(','))}">
                <div class="album-art-container">
                    <img src="${podcast.artwork || '/static/icon.svg'}" alt="${escapeHtml(podcast.name)}" class="album-art" loading="lazy">
                </div>
                <div class="album-info">
                    <div class="album-name">${escapeHtml(podcast.name)}</div>
                    <div class="album-artist">${escapeHtml(podcast.artist || '')}</div>
                    ${tagStr ? `<div class="podcast-tag-display" style="font-size: 0.7rem; opacity: 0.6; margin-top: 2px;">${escapeHtml(tagStr)}</div>` : ''}
                </div>
                <button class="podcast-fav-btn favorited" title="Remove from My Podcasts" data-podcast-id="${podcast.id}">❤️</button>
                <button class="podcast-tag-edit-btn" title="Edit Tags" data-podcast-id="${podcast.id}">🏷️</button>
            </div>
        `;
    });
    
    resultsContainer.innerHTML = headerHtml;
    resultsContainer.appendChild(grid);
    
    // Render recent podcast history section if available
    if (state.podcastHistory.length > 0) {
        const historySection = document.createElement('div');
        historySection.style.marginTop = '32px';
        historySection.innerHTML = `
            <h3 style="margin-bottom: 12px; color: var(--text-primary);">🕐 Recently Played Episodes</h3>
            <div class="results-list" id="podcast-history-list">
                ${state.podcastHistory.slice(0, 10).map(ep => {
                    const resumePos = getEpisodePosition(ep.id);
                    const resumeText = resumePos > 0 ? ` • Resume at ${formatTime(resumePos)}` : '';
                    const played = isEpisodePlayed(ep.id);
                    return `
                        <div class="track-item ${played ? 'episode-played' : ''}" data-id="${ep.id}" style="cursor: pointer;">
                            <img class="track-album-art" src="${ep.album_art || '/static/icon.svg'}" alt="Art" loading="lazy">
                            <div class="track-info">
                                <p class="track-name">${escapeHtml(ep.name)}</p>
                                <p class="track-artist">${escapeHtml(ep.artists)}${resumeText}</p>
                            </div>
                            <div class="track-actions">
                                <span class="track-duration">${ep.duration || ''}</span>
                                <button class="episode-played-btn ${played ? 'played' : ''}" data-episode-id="${ep.id}" title="${played ? 'Mark as unplayed' : 'Mark as played'}">
                                    ${played ? '✅' : '⬜'}
                                </button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        resultsContainer.appendChild(historySection);
        
        // Click handlers for history items
        historySection.querySelectorAll('.track-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.episode-played-btn')) return;
                const epId = el.dataset.id;
                const episode = state.podcastHistory.find(ep => ep.id === epId);
                if (episode) {
                    playTrack(episode);
                }
            });
        });
        
        // Played toggle handlers
        historySection.querySelectorAll('.episode-played-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const epId = btn.dataset.episodeId;
                const nowPlayed = toggleEpisodePlayed(epId);
                btn.textContent = nowPlayed ? '✅' : '⬜';
                btn.classList.toggle('played', nowPlayed);
                btn.title = nowPlayed ? 'Mark as unplayed' : 'Mark as played';
                btn.closest('.track-item').classList.toggle('episode-played', nowPlayed);
                showToast(nowPlayed ? 'Marked as played' : 'Marked as unplayed');
            });
        });
    }
    
    // Tag filter click handlers
    resultsContainer.querySelectorAll('.podcast-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            resultsContainer.querySelectorAll('.podcast-tag-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tag = btn.dataset.tag;
            const items = grid.querySelectorAll('.podcast-fav-item');
            items.forEach(item => {
                if (tag === 'all') {
                    item.style.display = '';
                } else {
                    const itemTags = (item.dataset.tags || '').split(',');
                    item.style.display = itemTags.includes(tag) ? '' : 'none';
                }
            });
        });
    });
    
    // Click handlers for podcast cards
    grid.querySelectorAll('.podcast-fav-item').forEach(el => {
        el.addEventListener('click', (e) => {
            // Handle unfavorite button
            if (e.target.closest('.podcast-fav-btn')) {
                e.stopPropagation();
                const id = e.target.closest('.podcast-fav-btn').dataset.podcastId;
                if (confirm('Remove this podcast from favorites?')) {
                    removePodcastFavorite(id);
                    renderMyPodcastsView();
                }
                return;
            }
            // Handle tag edit button
            if (e.target.closest('.podcast-tag-edit-btn')) {
                e.stopPropagation();
                const podcastId = e.target.closest('.podcast-tag-edit-btn').dataset.podcastId;
                openPodcastTagEditor(podcastId);
                return;
            }
            // Open episode list
            const podcastId = el.dataset.podcastId;
            if (podcastId) openPodcastEpisodes(podcastId);
        });
    });
} // end renderMyPodcastsView

// ========== MY BOOKS PAGE ==========
function renderMyBooksView() {
    const resultsContainer = document.getElementById('results-container');
    
    // Header
    let html = `
        <div class="search-header">
            <h2>📚 My Books</h2>
            <div>You have ${state.audiobookFavorites.length} saved books</div>
        </div>
    `;

    if (state.audiobookFavorites.length === 0) {
        html += `
            <div style="text-align: center; padding: 40px 20px;">
                <p>No saved books yet</p>
                <p style="font-size: 0.9em; opacity: 0.7;">Search for audiobooks and tap ❤️ to save them here</p>
                <button onclick="document.getElementById('search-input').focus(); document.getElementById('search-input').placeholder='Search audiobooks...';" class="btn-secondary" style="margin-top: 12px; padding: 8px 20px;">🔍 Search Books</button>
            </div>
        `;
        resultsContainer.innerHTML = html;
        return;
    }

    // Grid
    html += `<div class="dashboard-grid dashboard-grid-albums" id="my-books-grid">`;
    
    state.audiobookFavorites.forEach(book => {
        const hasCachedTracks = book.cachedTracks && book.cachedTracks.length > 0;
        const badgeText = hasCachedTracks ? '▶ Ready' : '⏳ Not cached';
        const badgeStyle = hasCachedTracks 
            ? 'background: rgba(29,185,84,0.85); color: #fff;' 
            : 'background: rgba(255,255,255,0.15); color: rgba(255,255,255,0.6);';
        
        // Check if there's a resume position for any track in this book
        let resumeInfo = '';
        if (hasCachedTracks) {
            for (const t of book.cachedTracks) {
                const pos = getEpisodePosition(t.id);
                if (pos > 10) {
                    const mins = Math.floor(pos / 60);
                    const secs = Math.floor(pos % 60);
                    resumeInfo = `<p class="dashboard-card-subtitle" style="color: var(--accent-color); font-size: 0.75em;">⏱ Resume Ch.${t.track_number} @ ${mins}:${String(secs).padStart(2,'0')}</p>`;
                    break; // Show only the first chapter with a resume point
                }
            }
        }
        
        html += `
            <div class="dashboard-card album-card book-fav-item" data-id="${book.id}">
                <button class="podcast-fav-btn favorited" title="Remove from My Books" data-book-id="${book.id}" style="position: absolute; top: 10px; right: 10px; z-index: 5;">❤️</button>
                <span style="position: absolute; top: 10px; left: 10px; z-index: 5; padding: 2px 8px; border-radius: 4px; font-size: 0.7em; ${badgeStyle}">${badgeText}</span>
                <img src="${book.artwork}" alt="${escapeHtml(book.name)}" loading="lazy">
                <div class="dashboard-card-info">
                    <p class="dashboard-card-title">${escapeHtml(book.name)}</p>
                    <p class="dashboard-card-subtitle">${escapeHtml(book.artist)}</p>
                    ${resumeInfo}
                </div>
            </div>
        `;
    });
    
    html += `</div>`;
    resultsContainer.innerHTML = html;

    // Render recently played audiobook chapters
    if (state.audiobookHistory.length > 0) {
        const historySection = document.createElement('div');
        historySection.style.marginTop = '32px';
        historySection.innerHTML = `
            <h3 style="margin-bottom: 12px; color: var(--text-primary);">🕐 Recently Played Chapters</h3>
            <div class="results-list" id="audiobook-history-list">
                ${state.audiobookHistory.slice(0, 10).map(ep => {
                    const resumePos = getEpisodePosition(ep.id);
                    const resumeText = resumePos > 0 ? ` • Resume at ${formatTime(resumePos)}` : '';
                    return `
                        <div class="track-item" data-id="${ep.id}" style="cursor: pointer;">
                            <img class="track-album-art" src="${ep.album_art || '/static/icon.svg'}" alt="Art" loading="lazy">
                            <div class="track-info">
                                <p class="track-name">${escapeHtml(ep.name)}</p>
                                <p class="track-artist">${escapeHtml(ep.artists)}${resumeText}</p>
                            </div>
                            <div class="track-actions">
                                <span class="track-duration">${ep.duration || ''}</span>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        resultsContainer.appendChild(historySection);

        // Click handlers for audiobook history items
        historySection.querySelectorAll('.track-item').forEach(el => {
            el.addEventListener('click', () => {
                const epId = el.dataset.id;
                let episode = state.audiobookHistory.find(ep => ep.id === epId);
                if (episode) {
                    // If history entry has no stream URL, try to resolve from cached tracks
                    if (!episode.src && !episode.url) {
                        for (const book of state.audiobookFavorites) {
                            if (book.cachedTracks) {
                                const cached = book.cachedTracks.find(t => t.id === epId);
                                if (cached) {
                                    episode = { ...episode, ...cached };
                                    break;
                                }
                            }
                        }
                    }
                    playTrack(episode);
                }
            });
        });
    }
    
    // Click handlers
    const grid = document.getElementById('my-books-grid');
    grid.querySelectorAll('.book-fav-item').forEach(el => {
        el.addEventListener('click', (e) => {
            // Unfavorite
            if (e.target.closest('.podcast-fav-btn')) {
                e.stopPropagation();
                const id = e.target.closest('.podcast-fav-btn').dataset.bookId;
                if (confirm('Remove this book from favorites?')) {
                    removeAudiobookFavorite(id);
                    renderMyBooksView();
                }
                return;
            }
            // Open book info modal
            const bookId = el.dataset.id;
            const book = state.audiobookFavorites.find(b => b.id === bookId);
            if (book) {
                openBookInfoModal(book);
            } else if (bookId) {
                openAudiobook(bookId);
            }
        });
    });
}
window.renderMyBooksView = renderMyBooksView;

// ========== BOOK INFO MODAL ==========
function openBookInfoModal(book) {
    const modal = document.getElementById('book-info-modal');
    const overlay = modal.querySelector('.book-info-overlay');
    const closeBtn = document.getElementById('book-info-close');
    
    // Populate header
    document.getElementById('book-info-art').src = book.artwork || '/static/icon.svg';
    document.getElementById('book-info-title').textContent = book.name;
    document.getElementById('book-info-author').textContent = book.artist || 'Unknown Author';
    
    // Badges
    const badgesEl = document.getElementById('book-info-badges');
    let badgeHtml = '';
    if (book.cachedTracks && book.cachedTracks.length > 0) {
        badgeHtml += `<span class="book-info-badge">📖 ${book.cachedTracks.length} chapters</span>`;
        badgeHtml += `<span class="book-info-badge" style="color: #1db954;">▶ Ready to play</span>`;
    } else {
        badgeHtml += `<span class="book-info-badge">⏳ Not yet downloaded</span>`;
    }
    badgesEl.innerHTML = badgeHtml;
    
    // Description
    const descEl = document.getElementById('book-info-description');
    descEl.textContent = book.description || 'No description available. Click "Goodreads Reviews" tab for book info.';
    
    // Reset tabs
    modal.querySelectorAll('.book-info-tab').forEach(t => t.classList.remove('active'));
    modal.querySelector('.book-info-tab[data-tab="description"]').classList.add('active');
    document.getElementById('book-info-desc-tab').classList.add('active');
    document.getElementById('book-info-reviews-tab').classList.remove('active');
    
    // Reset Goodreads section
    document.getElementById('book-info-goodreads').innerHTML = `
        <div class="book-info-loading">
            <div class="spinner"></div>
            <p>Fetching Goodreads data...</p>
        </div>
    `;
    
    // Tab switching
    modal.querySelectorAll('.book-info-tab').forEach(tab => {
        tab.onclick = () => {
            modal.querySelectorAll('.book-info-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.tab;
            document.getElementById('book-info-desc-tab').classList.toggle('active', target === 'description');
            document.getElementById('book-info-reviews-tab').classList.toggle('active', target === 'reviews');
            
            // Lazy-load Goodreads data on first tab click
            if (target === 'reviews' && !modal._goodreadsLoaded) {
                modal._goodreadsLoaded = true;
                fetchGoodreadsData(book.name, book.artist);
            }
        };
    });
    modal._goodreadsLoaded = false;
    
    // Play button
    const playBtn = document.getElementById('book-info-play-btn');
    // Check for resume position
    let resumeText = '▶ Play';
    if (book.cachedTracks && book.cachedTracks.length > 0) {
        for (const t of book.cachedTracks) {
            const pos = getEpisodePosition(t.id);
            if (pos > 10) {
                const mins = Math.floor(pos / 60);
                const secs = Math.floor(pos % 60);
                resumeText = `▶ Resume Ch.${t.track_number} @ ${mins}:${String(secs).padStart(2, '0')}`;
                break;
            }
        }
    }
    playBtn.textContent = resumeText;
    
    playBtn.onclick = () => {
        modal.classList.add('hidden');
        if (book.cachedTracks && book.cachedTracks.length > 0) {
            const albumData = {
                id: `ab_cached_${book.id}`,
                name: book.name,
                artists: 'Audiobook',
                image: book.artwork || '/static/icon.svg',
                is_playlist: false
            };
            showDetailView(albumData, book.cachedTracks);
        } else {
            openAudiobook(book.id);
        }
    };
    
    // Chapters button
    const chaptersBtn = document.getElementById('book-info-chapters-btn');
    if (book.cachedTracks && book.cachedTracks.length > 0) {
        chaptersBtn.style.display = '';
        chaptersBtn.onclick = () => {
            modal.classList.add('hidden');
            const albumData = {
                id: `ab_cached_${book.id}`,
                name: book.name,
                artists: 'Audiobook',
                image: book.artwork || '/static/icon.svg',
                is_playlist: false
            };
            showDetailView(albumData, book.cachedTracks);
        };
    } else {
        chaptersBtn.style.display = 'none';
    }
    
    // Close handlers
    const closeModal = () => modal.classList.add('hidden');
    closeBtn.onclick = closeModal;
    overlay.onclick = closeModal;
    
    // Show modal
    modal.classList.remove('hidden');
}

async function fetchGoodreadsData(title, author) {
    const container = document.getElementById('book-info-goodreads');
    const badgesEl = document.getElementById('book-info-badges');
    
    try {
        const params = new URLSearchParams({ title });
        if (author && author.toLowerCase() !== 'audiobookbay') params.set('author', author);
        
        const resp = await fetch(`/api/goodreads/book?${params}`);
        const data = await resp.json();
        
        if (!data.found) {
            container.innerHTML = `
                <div class="book-info-no-reviews">
                    <p>📚 No Goodreads data found for this book</p>
                    <a href="https://www.goodreads.com/search?q=${encodeURIComponent(title)}" target="_blank" rel="noopener" class="book-info-gr-link" style="margin-top: 10px;">🔍 Search on Goodreads</a>
                </div>
            `;
            return;
        }
        
        // Update badges with Goodreads rating
        if (data.rating) {
            const starCount = Math.round(parseFloat(data.rating));
            const stars = '★'.repeat(starCount) + '☆'.repeat(5 - starCount);
            badgesEl.innerHTML += `<span class="book-info-badge rating">⭐ ${data.rating}</span>`;
            if (data.rating_count) {
                badgesEl.innerHTML += `<span class="book-info-badge">${data.rating_count}</span>`;
            }
        }
        
        // Add genres
        if (data.genres && data.genres.length > 0) {
            data.genres.slice(0, 4).forEach(g => {
                badgesEl.innerHTML += `<span class="book-info-badge genres">${g}</span>`;
            });
        }
        
        // Update description if Goodreads has a better one
        const descEl = document.getElementById('book-info-description');
        if (data.description && data.description.length > (descEl.textContent || '').length) {
            descEl.textContent = data.description;
        }
        
        // Build reviews section
        let html = '';
        
        // Rating header
        if (data.rating) {
            const starCount = Math.round(parseFloat(data.rating));
            const starsDisplay = '★'.repeat(starCount) + '☆'.repeat(5 - starCount);
            html += `
                <div class="book-info-gr-header">
                    <div class="book-info-gr-rating">
                        <span class="book-info-gr-stars">${starsDisplay}</span>
                        <span class="book-info-gr-score">${data.rating}</span>
                        <span class="book-info-gr-count">${data.rating_count || ''} · ${data.review_count || ''}</span>
                    </div>
                    <a href="${data.url}" target="_blank" rel="noopener" class="book-info-gr-link">📖 Goodreads</a>
                </div>
            `;
        }
        
        // Reviews
        if (data.reviews && data.reviews.length > 0) {
            data.reviews.forEach(review => {
                const reviewStars = review.rating ? '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating) : '';
                html += `
                    <div class="book-info-review">
                        <div class="book-info-review-header">
                            <span class="book-info-reviewer">${escapeHtml(review.reviewer || 'Anonymous')}</span>
                            ${reviewStars ? `<span class="book-info-review-stars">${reviewStars}</span>` : ''}
                        </div>
                        ${review.date ? `<div class="book-info-review-date">${escapeHtml(review.date)}</div>` : ''}
                        <div class="book-info-review-text">${escapeHtml(review.text || 'No text')}</div>
                    </div>
                `;
            });
        } else {
            html += `<div class="book-info-no-reviews"><p>No reviews available</p></div>`;
        }
        
        // View all on Goodreads link
        if (data.url) {
            html += `
                <div style="text-align: center; margin-top: 16px;">
                    <a href="${data.url}" target="_blank" rel="noopener" class="book-info-gr-link">📖 View all reviews on Goodreads</a>
                </div>
            `;
        }
        
        container.innerHTML = html;
        
    } catch (err) {
        console.error('Goodreads fetch error:', err);
        container.innerHTML = `
            <div class="book-info-no-reviews">
                <p>⚠️ Failed to load Goodreads data</p>
                <a href="https://www.goodreads.com/search?q=${encodeURIComponent(title)}" target="_blank" rel="noopener" class="book-info-gr-link" style="margin-top: 10px;">🔍 Search on Goodreads manually</a>
            </div>
        `;
    }
}

// Tag editor modal
function openPodcastTagEditor(podcastId) {
    const podcast = state.podcastFavorites.find(p => p.id === podcastId);
    if (!podcast) return;
    
    const currentTags = getPodcastTags(podcastId);
    const allTags = getAllUsedTags();
    
    const tagInput = prompt(
        `Edit tags for "${podcast.name}"\n\nCurrent tags: ${currentTags.join(', ') || '(none)'}\n\nEnter tags separated by commas (e.g. Tech, Science, Comedy):`,
        currentTags.join(', ')
    );
    
    if (tagInput !== null) {
        const newTags = tagInput.split(',').map(t => t.trim()).filter(t => t.length > 0);
        setPodcastTags(podcastId, newTags);
        showToast(`Tags updated for "${podcast.name}"`);
        renderMyPodcastsView();
    }
}

function showPlaylistDetail(playlist) {
    // Track which playlist is being viewed
    state.currentPlaylistView = playlist.id;
    
    // Reuse the existing detail view
    const albumData = {
        id: playlist.id,
        name: playlist.name,
        artists: `${playlist.tracks.length} tracks`,
        image: playlist.tracks[0]?.album_art || '/static/icon.svg',
        is_playlist: true,
        is_user_playlist: true  // Flag to indicate this is a user-created playlist (for delete buttons)
    };
    showDetailView(albumData, playlist.tracks);
}

async function performSearch(query, append = false, silent = false) {
    if (!query) return;

    // Track search state for Load More
    if (!append) {
        state.searchOffset = 0;
        state.lastSearchQuery = query;
    }

    // Only show loading overlay for non-silent searches
    if (!silent) {
        showLoading(append ? 'Loading more...' : `Searching for "${query}"...`);
    }

    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${state.searchType}&offset=${state.searchOffset}`);
        const data = await response.json();

        if (!response.ok) throw new Error(data.detail || 'Search failed');

        // Only hide loading overlay for non-silent searches
        if (!silent) {
            hideLoading();
        }

        // Check if it was a Spotify URL
        // Check if it was a Spotify/Imported URL
        if (data.is_url) {
            // Auto-open detail view for albums/playlists
            if (data.tracks && (data.type === 'album' || data.type === 'playlist' || data.type === 'artist')) {
                showDetailView(data.results[0], data.tracks);
                return;
            }
            // Auto-play single track (e.g. YouTube link)
            if (data.results && data.results.length === 1 && data.type === 'track') {
                const track = data.results[0];
                playTrack(track);
                showToast(`Playing imported track: ${track.name}`);
                // Also render it so they can see it
            }
        }

        renderResults(data.results, data.type || state.searchType, append);

        // Update offset for next load
        state.searchOffset += data.results.length;

        // Show/hide Load More button
        const loadMoreBtn = $('#load-more-btn');
        if (loadMoreBtn) {
            if (data.results.length >= 20) {
                loadMoreBtn.classList.remove('hidden');
            } else {
                loadMoreBtn.classList.add('hidden');
            }
        }

    } catch (error) {
        console.error('Search error:', error);
        showError(error.message || 'Search failed. Please try again.');
    }
}

function renderResults(results, type, append = false) {
    const loadMoreBtn = $('#load-more-btn');
    
    // Store results for re-rendering (when sort changes)
    if (!append) {
        state.lastSearchResults = results || [];
        state.lastSearchType = type;
    } else if (results) {
        state.lastSearchResults = [...state.lastSearchResults, ...results];
    }
    
    if (!results || results.length === 0) {
        if (!append) {
            resultsContainer.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon">🔍</span>
                    <p>No results found</p>
                </div>
            `;
            if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
        }
        return;
    }
    
    let grid;
    // Helper to get or create Load More button
    let persistentLoadMoreBtn = document.getElementById('load-more-btn');
    if (persistentLoadMoreBtn) {
        persistentLoadMoreBtn.remove(); // Rescue it
    } else {
        // Create fresh if missing (e.g. after view switch)
        persistentLoadMoreBtn = document.createElement('button');
        persistentLoadMoreBtn.id = 'load-more-btn';
        persistentLoadMoreBtn.className = 'load-more-btn hidden';
        persistentLoadMoreBtn.textContent = 'Load More Results';
        persistentLoadMoreBtn.addEventListener('click', () => {
             if (state.lastSearchQuery) {
                 performSearch(state.lastSearchQuery, true);
             }
        });
    }

    if (append) {
        // Get existing grid or create new
        grid = resultsContainer.querySelector('.results-grid') || resultsContainer.querySelector('.results-list');
        if (!grid) {
            grid = document.createElement('div');
            // Use list layout for tracks, grid for others
            grid.className = (type === 'track') ? 'results-list' : 'results-grid';
            resultsContainer.innerHTML = '';
            resultsContainer.appendChild(grid);
        }
    } else {
        grid = document.createElement('div');
        // Use list layout for tracks, grid for others
        grid.className = (type === 'track') ? 'results-list' : 'results-grid';
        
        resultsContainer.innerHTML = '';
        resultsContainer.appendChild(grid);
    }
    
    // For 'podcast' we reuse album card style + add favorite heart overlay
    if (type === 'podcast') {
        results.forEach(item => {
            const isFav = isPodcastFavorited(item.id);
            const cardHtml = renderAlbumCard(item);
            // Wrap with a container that includes the heart button
            grid.innerHTML += `<div class="podcast-search-card-wrapper" style="position:relative;">
                ${cardHtml}
                <button class="podcast-fav-btn ${isFav ? 'favorited' : ''}" data-podcast-id="${item.id}" title="${isFav ? 'Remove from My Podcasts' : 'Save to My Podcasts'}">${isFav ? '❤️' : '🤍'}</button>
            </div>`;
        });
        // Wire up favorite buttons on search cards
        grid.querySelectorAll('.podcast-search-card-wrapper .podcast-fav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const podcastId = btn.dataset.podcastId;
                const podcast = results.find(r => r.id === podcastId);
                if (podcast) {
                    const nowFav = togglePodcastFavorite(podcast);
                    btn.textContent = nowFav ? '❤️' : '🤍';
                    btn.classList.toggle('favorited', nowFav);
                    btn.title = nowFav ? 'Remove from My Podcasts' : 'Save to My Podcasts';
                }
            });
        });
        // Wire up card clicks (need to go through wrapper)
        grid.querySelectorAll('.podcast-search-card-wrapper .album-card').forEach(el => {
            el.addEventListener('click', () => {
                console.log('Podcast card clicked, ID:', el.dataset.id);
                openPodcastEpisodes(el.dataset.id);
            });
        });
    } else if (type === 'track') {
        results.forEach(track => {
            grid.innerHTML += renderTrackCard(track);
        });
    } else if (type === 'album') {
        results.forEach(album => {
            grid.innerHTML += renderAlbumCard(album);
        });
    } else if (type === 'audiobook') {
        results.forEach(book => {
            // Map audiobook properties to album card format
            grid.innerHTML += renderAlbumCard({
                id: book.id,
                name: book.title,
                artists: 'AudiobookBay',
                album_art: book.cover_image,
                total_tracks: 'Audiobook'
            });
        });
    } else if (type === 'artist') {
        results.forEach(artist => {
            grid.innerHTML += renderArtistCard(artist);
        });
    }
    // Always append Load More button at the very end
    if (persistentLoadMoreBtn) {
        resultsContainer.appendChild(persistentLoadMoreBtn);
    }
    
    // Attach click listeners
    if (type === 'track') {
        grid.querySelectorAll('.track-item').forEach(el => {
            // Main card click (Play)
            el.addEventListener('click', (e) => {
                const trackId = String(el.dataset.id); 
                const track = results.find(t => String(t.id) === trackId);
                console.log('Track card clicked, ID:', trackId, 'Found:', track?.name);
                if (track) {
                    playTrack(track); 
                    showToast(`Playing "${track.name}"`);
                }
            });

            // Queue button click
            const queueBtn = el.querySelector('.queue-btn');
            if (queueBtn) {
                queueBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const trackId = String(el.dataset.id);
                    const track = results.find(t => String(t.id) === trackId);
                    if (track) addToQueue(track);
                });
            }
        });
        
        // Fetch features regarding DJ Mode
        if (state.djMode) {
            fetchAudioFeaturesForTracks(results);
        }
    } else if (type === 'album' || type === 'audiobook') {
        // Album/Audiobook cards - open modal
        grid.querySelectorAll('.album-card').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.dataset.id;
                if (type === 'audiobook') {
                    console.log('Audiobook card clicked, ID:', id);
                    openAudiobook(id);
                } else {
                    console.log('Album card clicked, ID:', id);
                    openAlbum(id);
                }
            });
        });
    } else if (type === 'podcast') {
        // Podcast click handlers already wired above in the render block
    } else if (type === 'artist') {
        grid.querySelectorAll('.artist-item').forEach((el, i) => {
            el.addEventListener('click', () => openArtist(results[i].id));
        });
    }

}

// Add track to queue (called from Queue button click)
function addToQueue(track) {
    if (!track) return;
    state.queue.push(track);
    updateQueueUI();
    showToast(`Added "${track.name}" to queue`);
}

const downloadModal = $('#download-modal');
const downloadTrackName = $('#download-track-name');
const downloadFormat = $('#download-format');
const downloadCancelBtn = $('#download-cancel-btn');
const downloadConfirmBtn = $('#download-confirm-btn');
const downloadAllBtn = $('#download-all-btn'); // New button
let trackToDownload = null;
let isBatchDownload = false; // Flag for batch mode

// ... functions ...

// ========== DOWNLOAD LOGIC ==========

window.openDownloadModal = function(trackJson) {
    const track = JSON.parse(decodeURIComponent(trackJson));
    trackToDownload = track;
    isBatchDownload = false;
    
    // Check if we are coming from detailed view (Album/Playlist)
    if (!detailView.classList.contains('hidden')) {
        state.pendingAlbumReopen = true;
    }
    
    downloadTrackName.textContent = `${track.name} - ${track.artists}`;
    downloadModal.classList.remove('hidden');
};

if (downloadAllBtn) {
    downloadAllBtn.addEventListener('click', () => {
        if (state.detailTracks.length === 0) return;
        
        isBatchDownload = true;
        trackToDownload = null;
        
        // Track previous view
        if (!detailView.classList.contains('hidden')) {
             state.pendingAlbumReopen = true;
        }
        
        // Get album/playlist name
        const name = $('.detail-name').textContent;
        // Sync state to ensure filename is correct even if state was lost
        state.detailName = name;
        
        downloadTrackName.textContent = `All tracks from "${name}" (ZIP)`;
        downloadModal.classList.remove('hidden');
    });
}

// Download current playing track buttons
const downloadCurrentBtn = $('#download-current-btn');
const fsDownloadBtn = $('#fs-download-btn');

function downloadCurrentTrack() {
    if (state.currentIndex < 0 || !state.queue[state.currentIndex]) {
        showToast('No track playing');
        return;
    }
    const track = state.queue[state.currentIndex];
    trackToDownload = track;
    isBatchDownload = false;
    downloadTrackName.textContent = `${track.name} - ${track.artists}`;
    
    // Filter format options based on track source
    updateDownloadFormatOptions(track);
    
    downloadModal.classList.remove('hidden');
}

// Update download format options based on track source quality
function updateDownloadFormatOptions(track) {
    const source = track?.source || '';
    const formatSelect = $('#download-format');
    const hiresGroup = $('#hires-formats');
    const sourceHint = $('#download-source-hint');
    
    // Categorize sources
    const isHiResSource = source === 'dab' || source === 'qobuz';
    const isHiFiSource = source === 'deezer' || source === 'jamendo' || source === 'tidal';
    const isLossySource = source === 'ytmusic' || source === 'youtube' || source === 'podcast' || 
                          source === 'import' || source === 'archive' || source === 'phish' ||
                          source === 'soundcloud' || source === 'bandcamp';
    
    // Re-enable all options first
    formatSelect.querySelectorAll('option, optgroup').forEach(el => {
        el.disabled = false;
        el.style.display = '';
    });
    
    // Hide/show hint
    if (sourceHint) {
        sourceHint.classList.add('hidden');
        sourceHint.textContent = '';
    }
    
    if (isLossySource) {
        // Lossy source: only MP3 available
        formatSelect.querySelectorAll('option').forEach(opt => {
            if (opt.dataset.minQuality !== 'lossy') {
                opt.disabled = true;
                opt.style.display = 'none';
            }
        });
        // Hide optgroups for lossless
        formatSelect.querySelectorAll('optgroup').forEach(grp => {
            if (grp.label !== 'Lossy') {
                grp.style.display = 'none';
            }
        });
        formatSelect.value = 'mp3';
        if (sourceHint) {
            sourceHint.textContent = `⚠️ Source is ${source || 'external'} - only MP3 available`;
            sourceHint.classList.remove('hidden');
        }
    } else if (isHiFiSource && !isHiResSource) {
        // HiFi source (16-bit lossless): hide 24-bit options
        if (hiresGroup) hiresGroup.style.display = 'none';
        formatSelect.querySelectorAll('option[data-min-quality="hires"]').forEach(opt => {
            opt.disabled = true;
            opt.style.display = 'none';
        });
        formatSelect.value = 'flac';
    } else if (isHiResSource) {
        // Hi-Res source: show 24-bit only if Hi-Res mode is enabled
        if (!state.hiResMode) {
            if (hiresGroup) hiresGroup.style.display = 'none';
            formatSelect.querySelectorAll('option[data-min-quality="hires"]').forEach(opt => {
                opt.disabled = true;
                opt.style.display = 'none';
            });
            formatSelect.value = 'flac';
            if (sourceHint) {
                sourceHint.textContent = '💡 Enable Hi-Res mode for 24-bit options';
                sourceHint.classList.remove('hidden');
            }
        } else {
            // All options available
            formatSelect.value = 'flac_24';
        }
    } else {
        // Unknown source: default to 16-bit lossless, show 24-bit only if Hi-Res mode
        if (!state.hiResMode) {
            if (hiresGroup) hiresGroup.style.display = 'none';
            formatSelect.querySelectorAll('option[data-min-quality="hires"]').forEach(opt => {
                opt.disabled = true;
                opt.style.display = 'none';
            });
        }
        formatSelect.value = 'flac';
    }
}

if (downloadCurrentBtn) {
    downloadCurrentBtn.addEventListener('click', downloadCurrentTrack);
}

if (fsDownloadBtn) {
    fsDownloadBtn.addEventListener('click', downloadCurrentTrack);
}

function closeDownloadModal() {
    downloadModal.classList.add('hidden');
    trackToDownload = null;
    isBatchDownload = false;
    
    // Restore Album/Playlist view if it was active
    if (state.pendingAlbumReopen) {
        detailView.classList.remove('hidden'); 
        state.pendingAlbumReopen = false;
        // Also ensure Results are hidden if we are in detail view
        resultsSection.classList.add('hidden');
    }
}

downloadCancelBtn.addEventListener('click', closeDownloadModal);

// Background Download UI Helpers
const downloadIndicator = $('#download-indicator');
const downloadStatusText = $('#download-status-text');
const downloadProgressFill = $('#download-progress-fill');
const downloadMinimizeBtn = $('#download-minimize-btn');

function updateDownloadUI(percent, text) {
    if (downloadIndicator && downloadIndicator.classList.contains('hidden')) {
        downloadIndicator.classList.remove('hidden');
    }
    if (text && downloadStatusText) downloadStatusText.textContent = text;
    if (downloadProgressFill) downloadProgressFill.style.width = `${percent}%`;
}

function hideDownloadUI() {
    if (downloadIndicator) downloadIndicator.classList.add('hidden');
    if (downloadProgressFill) downloadProgressFill.style.width = '0%';
}

if (downloadMinimizeBtn) {
    downloadMinimizeBtn.addEventListener('click', () => {
        if (downloadIndicator) downloadIndicator.classList.add('hidden');
    });
}

downloadConfirmBtn.addEventListener('click', async () => {
    const format = downloadFormat.value;
    const track = trackToDownload; // Capture before closing modal clears it
    const isBatch = isBatchDownload;
    
    // Get album/playlist name from state
    const name = state.detailName || 'Batch Download';
    const artist = state.detailArtist || '';
    const albumName = artist ? `${artist} - ${name}` : name;
    
    closeDownloadModal();
    
    // Show Background UI
    updateDownloadUI(2, 'Starting download...');
    
    if (isBatch) {
        // Multi-Part Batch Download for Large Playlists
        const tracks = state.detailTracks;
        const totalTracks = tracks.length;
        const CHUNK_SIZE = 50; // 50 songs per ZIP
        const totalParts = Math.ceil(totalTracks / CHUNK_SIZE);
        
        // Hide overlay elements just in case
        const progressContainer = $('#loading-progress-container');
        if (progressContainer) progressContainer.classList.add('hidden');
        
        let successfulParts = 0;
        let failedParts = [];
        
        try {
            for (let part = 1; part <= totalParts; part++) {
                const start = (part - 1) * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, totalTracks);
                const chunkTracks = tracks.slice(start, end);
                
                // Update message
                const partLabel = totalParts > 1 ? ` (Part ${part}/${totalParts})` : '';
                updateDownloadUI(0, `Downloading${partLabel}: ${chunkTracks.length} tracks...`);
                
                // Real-Time Progress Polling
                const downloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                let pollInterval;
                
                pollInterval = setInterval(async () => {
                    try {
                        const progRes = await fetch(`/api/progress/${downloadId}`);
                        if (progRes.ok) {
                            const progData = await progRes.json();
                            if (progData.total > 0) {
                                const chunkProgress = (progData.current / progData.total) * 100;
                                // Overall progress
                                const overallProgress = ((successfulParts / totalParts) * 100) + (chunkProgress / totalParts);
                                updateDownloadUI(overallProgress);
                            }
                        }
                    } catch (e) {
                        console.warn('Progress poll failed:', e);
                    }
                }, 2000); 
                
                try {
                    const response = await fetch('/api/download-batch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            tracks: chunkTracks.map(t => t.isrc || t.id),
                            names: chunkTracks.map(t => t.name),
                            artists: chunkTracks.map(t => t.artists),
                            zip_name: albumName,
                            album_name: (state.detailType === 'album' && (state.detailReleaseYear || chunkTracks[0]?.release_date)) ? albumName : null,
                            format: format,
                            part: part,
                            total_parts: totalParts,
                            download_id: downloadId,
                            album_art_urls: chunkTracks.map(t => t.album_art || t.image || state.detailCover || null),
                            release_year: state.detailReleaseYear || (chunkTracks[0]?.release_date?.substring(0, 4)) || '',
                        })
                    });
                    
                    clearInterval(pollInterval);
                    
                    if (!response.ok) throw new Error(`Part ${part} failed`);
                    
                    // Download ZIP
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.style.display = 'none';
                    a.href = url;
                    
                    const zipName = totalParts > 1 
                        ? `${albumName} (Part ${part} of ${totalParts}).zip`
                        : `${albumName}.zip`;
                    a.download = zipName.replace(/[\\/:"*?<>|]/g, "_");
                    document.body.appendChild(a);
                    a.click();
                    window.URL.revokeObjectURL(url);
                    document.body.removeChild(a);
                    
                    successfulParts++;
                    
                    if (part < totalParts) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    
                } catch (partError) {
                    clearInterval(pollInterval);
                    console.error(`Part ${part} error:`, partError);
                    failedParts.push(part);
                    showError(`Download Part ${part} failed`);
                }
            }
            
            updateDownloadUI(100, 'Download complete!');
            setTimeout(hideDownloadUI, 3000);
            
            if (failedParts.length === 0) {
                showToast(totalParts > 1 ? `Download complete! ${totalParts} parts saved.` : 'Download complete!');
            }
            
        } catch (error) {
            console.error('Batch download error:', error);
            hideDownloadUI();
            showError('Batch download failed');
        }
        return;
    }

    if (!track) return;
    
    // Single Track Logic
    updateDownloadUI(0, `Downloading "${track.name}"...`);
    
    try {
        const query = `${track.name} ${track.artists}`;
        const isrc = track.isrc || track.id; 
        const ext = format === 'alac' ? 'm4a' : format.replace(/_24$/, '');
        const filename = `${track.artists} - ${track.name}.${ext}`.replace(/[\\/:"*?<>|]/g, "_");
        
        const hiresParam = state.hiResMode ? '&hires=true' : '&hires=false';
        const qualityParam = state.hiResMode ? `&hires_quality=${state.hiResQuality}` : '';
        const response = await fetch(`/api/download/${isrc}?q=${encodeURIComponent(query)}&format=${format}&filename=${encodeURIComponent(filename)}${hiresParam}${qualityParam}`);
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Download failed');
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        updateDownloadUI(100, 'Download complete!');
        setTimeout(hideDownloadUI, 3000);
        showToast(`Downloaded "${track.name}"`);
        
    } catch (error) {
        console.error('Download error:', error);
        hideDownloadUI();
        showError('Failed to download track.');
    }
});
        

function renderTrackCard(track) {
    const year = track.release_date ? String(track.release_date).slice(0, 4) : '';
    const isStarred = isInLibrary(track.id);
    
    // Check for HiRes quality
    const isHiRes = track.is_hi_res || track.is_hires || track.audio_quality?.isHiRes || false;
    const hiResBadge = isHiRes ? '<span class="hires-badge">HI-RES</span>' : '';

    return `
        <div class="track-item" data-id="${track.id}">
            <img class="track-album-art" src="${track.album_art || '/static/icon.svg'}" alt="${escapeHtml(track.name)}" loading="lazy">
            <div class="track-info">
                <div class="track-name">${hiResBadge}${escapeHtml(track.name)}</div>
                <div class="track-artist">${escapeHtml(track.artists)}</div>
            </div>
            <span class="track-duration">${track.duration_ms ? formatTime(track.duration_ms / 1000) : (track.duration && track.duration.toString().includes(':') ? track.duration : formatTime(track.duration))}</span>
            <button class="star-btn ${isStarred ? 'starred' : ''}" data-track-id="${track.id}" title="${isStarred ? 'Remove from Library' : 'Add to Library'}">${isStarred ? '★' : '☆'}</button>
            <button class="track-action-btn queue-btn" title="Add to Queue">+</button>
        </div>
    `;
}

// ... (keep renderAlbumCard and renderArtistCard as is) ...

function renderAlbumCard(album) {
    const year = (album.release_date && album.release_date.length >= 4) ? album.release_date.slice(0, 4) : '';
    const trackCount = album.total_tracks ? `${album.total_tracks} tracks` : '';
    // Check for HiRes quality (if available from API)
    const isHiRes = album.is_hi_res || album.is_hires || album.audio_quality?.isHiRes || false;
    const hiResBadge = isHiRes ? '<span class="hires-badge">HI-RES</span>' : '';
    
    return `
        <div class="album-card" data-id="${album.id}" data-year="${year || '0'}">
            <div class="album-card-art-container">
                <img class="album-card-art" src="${album.album_art || '/static/icon.svg'}" alt="${escapeHtml(album.name)}" loading="lazy">
                ${hiResBadge}
            </div>
            <div class="album-card-info">
                <p class="album-card-title">${escapeHtml(album.name)}</p>
                <p class="album-card-artist">${escapeHtml(album.artists)}</p>
                <div class="album-card-meta">
                    <span>${trackCount}</span>
                    <span>${year}</span>
                </div>
            </div>
        </div>
    `;
}

function renderArtistCard(artist) {
    const followers = artist.followers ? `${(artist.followers / 1000).toFixed(0)}K followers` : '';
    return `
        <div class="artist-item" data-id="${artist.id}">
            <img class="artist-art" src="${artist.image || '/static/icon.svg'}" alt="Artist" loading="lazy">
            <div class="artist-info">
                <p class="artist-name">${escapeHtml(artist.name)}</p>
                <p class="artist-genres">${artist.genres?.slice(0, 2).join(', ') || 'Artist'}</p>
                <p class="artist-followers">${followers}</p>
            </div>
        </div>
    `;
}

async function openAlbum(albumId) {
    // Intercept setlists to open special modal
    if (albumId.startsWith('setlist_')) {
        openSetlistModal(albumId);
        return;
    }

    showLoading('Loading album...');
    try {
        const response = await fetch(`/api/album/${albumId}`);
        const album = await response.json();
        if (!response.ok) throw new Error(album.detail);
        
        hideLoading();
        console.log('Opening album modal for:', album.name, album);
        
        // Store album info in state for batch downloads
        state.detailName = album.name || '';
        state.detailArtist = album.artists || '';
        console.log('✅ Stored in state - name:', state.detailName, 'artist:', state.detailArtist);
        
        showAlbumModal(album);
    } catch (error) {
        console.error('Failed to load album:', error);
        showError('Failed to load album');
    }
}

// Open podcast episodes in detail view (not album modal)
async function openPodcastEpisodes(podcastId) {
    showLoading('Loading podcast episodes...');
    try {
        const response = await fetch(`/api/album/${podcastId}`);
        const podcast = await response.json();
        if (!response.ok) throw new Error(podcast.detail);
        
        hideLoading();
        console.log('Opening podcast episodes:', podcast.name, podcast);
        
        // Use detail view for podcasts (allows clicking episodes for info modal)
        showDetailView(podcast, podcast.tracks || []);
        
        // After detail view renders, inject podcast-specific controls
        setTimeout(() => {
            // Add favorite toggle button to detail header
            const detailActions = document.querySelector('.detail-actions');
            if (detailActions && !detailActions.querySelector('.podcast-detail-fav-btn')) {
                const isFav = isPodcastFavorited(podcastId);
                const favBtn = document.createElement('button');
                favBtn.className = `detail-add-library-btn podcast-detail-fav-btn ${isFav ? 'saved' : ''}`;
                favBtn.innerHTML = isFav ? '❤️ In My Podcasts' : '🤍 Save to My Podcasts';
                favBtn.addEventListener('click', () => {
                    const nowFav = togglePodcastFavorite(podcast);
                    favBtn.innerHTML = nowFav ? '❤️ In My Podcasts' : '🤍 Save to My Podcasts';
                    favBtn.classList.toggle('saved', nowFav);
                });
                detailActions.appendChild(favBtn);
            }
            
            // Add played/download buttons to each episode row
            const trackItems = document.querySelectorAll('#detail-tracks .track-item');
            const tracks = podcast.tracks || [];
            trackItems.forEach((el, i) => {
                const track = tracks[i];
                if (!track || track.source !== 'podcast') return;
                
                const actionsDiv = el.querySelector('.track-actions');
                if (!actionsDiv || actionsDiv.querySelector('.episode-played-btn')) return;
                
                // Mark as played button
                const played = isEpisodePlayed(track.id);
                const playedBtn = document.createElement('button');
                playedBtn.className = `episode-played-btn ${played ? 'played' : ''}`;
                playedBtn.textContent = played ? '✅' : '⬜';
                playedBtn.title = played ? 'Mark as unplayed' : 'Mark as played';
                playedBtn.dataset.episodeId = track.id;
                playedBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const nowPlayed = toggleEpisodePlayed(track.id);
                    playedBtn.textContent = nowPlayed ? '✅' : '⬜';
                    playedBtn.classList.toggle('played', nowPlayed);
                    playedBtn.title = nowPlayed ? 'Mark as unplayed' : 'Mark as played';
                    el.classList.toggle('episode-played', nowPlayed);
                });
                actionsDiv.insertBefore(playedBtn, actionsDiv.firstChild);
                
                // Add played visual
                if (played) el.classList.add('episode-played');
                
                // Resume position indicator
                const resumePos = getEpisodePosition(track.id);
                if (resumePos > 10) {
                    const infoDiv = el.querySelector('.track-artist');
                    if (infoDiv && !infoDiv.textContent.includes('Resume')) {
                        infoDiv.textContent += ` • Resume at ${formatTime(resumePos)}`;
                    }
                }
            });
        }, 100);
    } catch (error) {
        console.error('Failed to load podcast:', error);
        showError('Failed to load podcast');
    }
}

// ========== SETLIST MODAL ==========
const setlistModal = $('#setlist-modal');
const setlistCloseBtn = $('#setlist-close-btn');
const setlistInfo = $('#setlist-info');
const setlistTracks = $('#setlist-tracks');
const setlistPlayBtn = $('#setlist-play-btn');
let currentSetlist = null;

if (setlistCloseBtn) {
    setlistCloseBtn.addEventListener('click', () => {
        setlistModal.classList.add('hidden');
    });
}

if (setlistPlayBtn) {
    setlistPlayBtn.addEventListener('click', () => {
        if (currentSetlist) {
            setlistModal.classList.add('hidden');
            // Check if we have a direct audio source URL or need to search
            if (currentSetlist.audio_url) {
                // Direct import (Phish.in) - use performSearch which handles URLs
                performSearch(currentSetlist.audio_url);
            } else if (currentSetlist.audio_search) {
                // Search Archive.org (Artist Date)
                performSearch(currentSetlist.audio_search);
            } else {
                showError("No audio source found for this setlist.");
            }
        }
    });
}

async function openSetlistModal(setlistId) {
    // Get modal elements fresh each time
    const modal = document.getElementById('setlist-modal');
    const infoEl = document.getElementById('setlist-info');
    const tracksEl = document.getElementById('setlist-tracks');
    const playBtn = document.getElementById('setlist-play-btn');
    
    if (!modal) {
        showError("Setlist modal not available");
        return;
    }
    
    showLoading('Fetching setlist...');
    try {
        // Use existing endpoint which returns formatted setlist
        const response = await fetch(`/api/album/${setlistId}`);
        const setlist = await response.json();
        
        if (!response.ok) throw new Error(setlist.detail);
        
        currentSetlist = setlist;
        hideLoading();
        
        // Render Modal Content
        infoEl.innerHTML = `
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="font-size: 1.5rem; margin-bottom: 4px;">${escapeHtml(setlist.artists)}</h2>
                <p style="font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 4px;">${escapeHtml(setlist.venue)}</p>
                <p style="font-size: 1rem; color: var(--accent-color);">${setlist.date || setlist.release_date}</p>
                <p style="font-size: 0.9rem; color: var(--text-tertiary); margin-top: 8px;">
                    ${setlist.city}
                </p>
            </div>
        `;
        
        tracksEl.innerHTML = setlist.tracks.map((track, i) => `
            <div class="setlist-track-item" style="display: flex; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
                <span style="color: var(--text-tertiary); width: 30px; text-align: right; margin-right: 12px; font-variant-numeric: tabular-nums;">${i + 1}</span>
                <div style="flex: 1;">
                    <div style="display: flex; justify-content: space-between; align-items: baseline;">
                        <span style="font-weight: 500;">${escapeHtml(track.name)}</span>
                        ${track.set_name ? `<span style="font-size: 0.75rem; color: var(--text-tertiary); background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px;">${track.set_name}</span>` : ''}
                    </div>
                    ${track.info ? `<p style="font-size: 0.8rem; color: var(--text-tertiary); margin: 2px 0 0;">${escapeHtml(track.info)}</p>` : ''}
                    ${track.cover_info ? `<p style="font-size: 0.8rem; color: var(--text-tertiary); margin: 2px 0 0;">(Cover of ${escapeHtml(track.cover_info)})</p>` : ''}
                </div>
            </div>
        `).join('');
        
        // Show audio source button label
        if (setlist.audio_source === 'phish.in') {
            playBtn.textContent = "🎧 Listen on Phish.in";
        } else {
            playBtn.textContent = "🎧 Search on Archive.org";
        }
        
        modal.classList.remove('hidden');
        
    } catch (error) {
        console.error(error);
        showError('Failed to load setlist');
    }
}

// ========== ALBUM DETAILS MODAL ==========
const albumModal = $('#album-modal');
const albumModalClose = $('#album-modal-close');
const albumModalOverlay = albumModal?.querySelector('.album-modal-overlay');
let currentAlbumData = null;

// Close modal
if (albumModalClose) {
    albumModalClose.addEventListener('click', () => {
        albumModal.classList.add('hidden');
    });
}

// Close on overlay click
if (albumModalOverlay) {
    albumModalOverlay.addEventListener('click', () => {
        albumModal.classList.add('hidden');
    });
}

// Tab switching
const albumTabs = albumModal?.querySelectorAll('.album-tab');
albumTabs?.forEach(tab => {
    tab.addEventListener('click', () => {
        albumTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        const tabName = tab.dataset.tab;
        if (tabName === 'tracks') {
            $('#album-modal-tracks')?.classList.remove('hidden');
            $('#album-modal-info-tab')?.classList.add('hidden');
        } else {
            $('#album-modal-tracks')?.classList.add('hidden');
            $('#album-modal-info-tab')?.classList.remove('hidden');
        }
    });
});

// Action buttons
$('#album-play-btn')?.addEventListener('click', () => {
    if (currentAlbumData?.tracks?.length) {
        state.queue = [...currentAlbumData.tracks];
        state.currentIndex = 0;
        updateQueueUI();
        loadTrack(state.queue[0]);
        albumModal.classList.add('hidden');
        showToast(`Playing "${currentAlbumData.name}"`);
    }
});

$('#album-queue-btn')?.addEventListener('click', () => {
    if (currentAlbumData?.tracks?.length) {
        state.queue.push(...currentAlbumData.tracks);
        updateQueueUI();
        albumModal.classList.add('hidden');
        showToast(`Added ${currentAlbumData.tracks.length} tracks to queue`);
    }
});

$('#album-download-btn')?.addEventListener('click', () => {
    if (currentAlbumData) {
        // Get only selected tracks based on checked checkboxes
        const checkedIndices = new Set();
        document.querySelectorAll('#album-modal-tracks .track-select-cb:checked').forEach(cb => {
            checkedIndices.add(parseInt(cb.dataset.index));
        });
        
        const selectedTracks = currentAlbumData.tracks.filter((_, i) => checkedIndices.has(i));
        
        if (selectedTracks.length === 0) {
            showToast('Please select at least one track to download');
            return;
        }
        
        isBatchDownload = true;
        trackToDownload = null;
        state.detailTracks = selectedTracks;
        downloadTrackName.textContent = `${currentAlbumData.name} (${selectedTracks.length} of ${currentAlbumData.tracks.length} tracks)`;
        downloadModal.classList.remove('hidden');
        albumModal.classList.add('hidden');
    }
});

$('#album-playlist-btn')?.addEventListener('click', () => {
    if (currentAlbumData?.tracks?.length) {
        // Open add to playlist modal with all album tracks
        if (typeof openAddToPlaylistModal === 'function') {
            openAddToPlaylistModal(currentAlbumData.tracks, currentAlbumData.name);
        } else {
            showToast('Playlist feature coming soon');
        }
    }
});

function showAlbumModal(album) {
    if (!albumModal) return;
    
    currentAlbumData = album;
    const tracks = album.tracks || [];
    
    // Populate modal data
    $('#album-modal-art').src = album.album_art || album.image || '/static/icon.svg';
    $('#album-modal-title').textContent = album.name || 'Unknown Album';
    $('#album-modal-artist').textContent = album.artists || 'Unknown Artist';
    
    // Metadata pills
    const date = album.release_date || '';
    const genre = album.genres?.[0] || album.genre || '';
    const trackCount = tracks.length || album.total_tracks || 0;
    const totalDuration = tracks.reduce((sum, t) => sum + (parseDuration(t.duration) || 0), 0);
    const durationMins = Math.round(totalDuration / 60);
    
    $('#album-modal-date').textContent = `📅 ${date || 'Unknown'}`;
    $('#album-modal-trackcount').textContent = `🎵 ${trackCount} tracks`;
    $('#album-modal-duration').textContent = `⏱️ ${durationMins || '??'} min`;
    
    // Add All to Library button
    const allInLibrary = tracks.length > 0 && tracks.every(t => isInLibrary(t.id));
    const addToLibBtn = $('#album-add-to-library-btn');
    if (addToLibBtn) {
        addToLibBtn.textContent = allInLibrary ? '✓ In Library' : '★ Add to Library';
        addToLibBtn.disabled = allInLibrary;
        addToLibBtn.classList.toggle('saved', allInLibrary);
        addToLibBtn.onclick = () => {
            addAllToLibrary(tracks);
            // Update button state
            addToLibBtn.textContent = '★ In Library';
            addToLibBtn.disabled = true;
            addToLibBtn.classList.add('saved');
            // Update star buttons in track list
            tracksContainer.querySelectorAll('.star-btn').forEach(btn => {
                btn.textContent = '★';
                btn.classList.add('starred');
                btn.title = 'Remove from Library';
            });
        };
    }
    
    // Quality badge
    const format = album.format || (state.hifiMode ? 'FLAC' : 'MP3');
    const bitDepth = album.audio_quality?.maximumBitDepth || 16;
    const sampleRate = album.audio_quality?.maximumSamplingRate || 44.1;
    $('#album-modal-quality').textContent = `🎵 ${format} • ${bitDepth}bit / ${sampleRate}kHz`;
    
    // Render track list with selection checkboxes for batch download
    const tracksContainer = $('#album-modal-tracks');
    tracksContainer.innerHTML = tracks.map((track, i) => {
        const isStarred = isInLibrary(track.id);
        return `
        <div class="album-modal-track" data-index="${i}">
            <div class="track-row-top">
                <input type="checkbox" class="track-select-cb" data-index="${i}" checked title="Select for download">
                <span class="album-track-num">${i + 1}.</span>
                <button class="album-track-play" title="Play" data-index="${i}">▶</button>
                <div class="album-track-info">
                    <p class="album-track-name">${escapeHtml(track.name)}</p>
                </div>
            </div>
            <div class="track-row-actions">
                <button class="star-btn ${isStarred ? 'starred' : ''}" data-track-id="${track.id}" data-index="${i}" title="${isStarred ? 'Remove from Library' : 'Add to Library'}">${isStarred ? '★' : '☆'}</button>
                <button class="album-track-playlist" title="Add to Playlist" data-index="${i}">♡</button>
                <span class="album-track-duration">${typeof track.duration === 'number' ? formatTime(track.duration) : (track.duration || '--:--')}</span>
                <button title="Add to Queue" data-action="queue" data-index="${i}">+</button>
                <button title="Download" data-action="download" data-index="${i}">⬇</button>
            </div>
        </div>
    `}).join('');
    
    // Track click handlers
    tracksContainer.querySelectorAll('.album-track-play').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index);
            state.queue = [...tracks];
            state.currentIndex = idx;
            updateQueueUI();
            loadTrack(tracks[idx]);
            albumModal.classList.add('hidden');
        });
    });
    
    tracksContainer.querySelectorAll('[data-action="queue"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index);
            state.queue.push(tracks[idx]);
            updateQueueUI();
            showToast(`Added "${tracks[idx].name}" to queue`);
        });
    });
    
    // Playlist button handler
    tracksContainer.querySelectorAll('.album-track-playlist').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index);
            const track = tracks[idx];
            // Open add to playlist modal
            if (typeof openAddToPlaylistModal === 'function') {
                openAddToPlaylistModal(track);
            } else {
                showToast('Playlist feature coming soon');
            }
        });
    });
    
    tracksContainer.querySelectorAll('[data-action="download"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index);
            // Hide album modal first so download modal appears on top
            albumModal.classList.add('hidden');
            // Store album data so we can reopen after download closes
            state.pendingAlbumReopen = { album, tracks };
            openDownloadModal(encodeURIComponent(JSON.stringify(tracks[idx])));
        });
    });
    
    // Star button handler for album modal
    tracksContainer.querySelectorAll('.star-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index);
            const track = tracks[idx];
            if (track) {
                const nowStarred = toggleLibrary(track);
                btn.textContent = nowStarred ? '★' : '☆';
                btn.classList.toggle('starred', nowStarred);
                btn.title = nowStarred ? 'Remove from Library' : 'Add to Library';
            }
        });
    });
    
    // Track selection handlers
    const selectAllCb = $('#select-all-tracks');
    const selectionCount = $('#track-selection-count');
    
    function updateSelectionCount() {
        const checked = tracksContainer.querySelectorAll('.track-select-cb:checked').length;
        const total = tracks.length;
        selectionCount.textContent = `${checked} of ${total} selected`;
        
        // Update Select All checkbox state
        if (selectAllCb) {
            selectAllCb.checked = checked === total;
            selectAllCb.indeterminate = checked > 0 && checked < total;
        }
    }
    
    // Select All toggle
    if (selectAllCb) {
        selectAllCb.addEventListener('change', () => {
            const isChecked = selectAllCb.checked;
            tracksContainer.querySelectorAll('.track-select-cb').forEach(cb => {
                cb.checked = isChecked;
            });
            updateSelectionCount();
        });
    }
    
    // Individual checkbox changes
    tracksContainer.querySelectorAll('.track-select-cb').forEach(cb => {
        cb.addEventListener('change', updateSelectionCount);
    });
    
    // Initial count
    updateSelectionCount();
    
    // Album Info tab
    $('#album-modal-description').textContent = album.description || 
        `${album.name} by ${album.artists}. Released ${date}. ${trackCount} tracks.`;
    
    // Reset to tracks tab
    albumTabs?.forEach(t => t.classList.remove('active'));
    albumModal.querySelector('[data-tab="tracks"]')?.classList.add('active');
    $('#album-modal-tracks')?.classList.remove('hidden');
    $('#album-modal-info-tab')?.classList.add('hidden');
    
    // Show modal
    albumModal.classList.remove('hidden');
}

// Helper to parse duration string to seconds
function parseDuration(dur) {
    if (!dur) return 0;
    if (typeof dur === 'number') return dur;
    if (typeof dur === 'string' && !dur.includes(':')) return Number(dur) || 0;
    const parts = dur.toString().split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
}

async function openArtist(artistId) {
    showLoading('Loading artist...');
    try {
        const response = await fetch(`/api/artist/${artistId}`);
        const artist = await response.json();
        if (!response.ok) throw new Error(artist.detail);
        
        hideLoading();
        showDetailView(artist, artist.tracks);
    } catch (error) {
        showError('Failed to load artist');
    }
}

// Updated showDetailView to handle downloads
function showDetailView(item, tracks) {
    state.detailTracks = tracks || [];
    
    // Store name and artist for batch downloads
    state.detailName = item.name || 'Playlist';
    // Determine type: Only force album tagging if explicitly an album AND has a release date.
    // Playlists, Artists, and Custom Lists should preserve original track album tags.
    state.detailType = (item.type === 'album' && item.release_date) ? 'album' : 'playlist';
    
    // Handle owner if it's an object (Spotify playlist) or string
    let artistName = item.artists || '';
    if (!artistName && item.owner) {
        artistName = typeof item.owner === 'object' ? item.owner.display_name : item.owner;
    }
    state.detailArtist = artistName || '';
    
    // Store release year for metadata embedding
    state.detailReleaseYear = item.release_date?.substring(0, 4) || '';
    // Store cover art for metadata embedding (fallback for tracks)
    state.detailCover = item.album_art || item.image || null;
    
    // Render info section
    const isArtist = item.type === 'artist';
    const isUserPlaylist = item.is_user_playlist || false;
    const image = item.album_art || item.image || '/static/icon.svg';
    const subtitle = item.artists || item.owner || (item.genres?.slice(0, 2).join(', ')) || '';
    const stats = item.total_tracks ? `${item.total_tracks} tracks` : 
                  item.followers ? `${(item.followers / 1000).toFixed(0)}K followers` : '';
    
    // Check if all tracks already in library
    const allInLibrary = tracks.length > 0 && tracks.every(t => isInLibrary(t.id));
    
    detailInfo.innerHTML = `
        <img class="detail-art${isArtist ? ' artist-art' : ''}" src="${image}" alt="Cover">
        <div class="detail-meta">
            <p class="detail-name">${escapeHtml(item.name)}</p>
            <p class="detail-artist">${escapeHtml(subtitle)}</p>
            <p class="detail-stats">${stats}</p>
            <div class="detail-actions">
                <button class="detail-add-library-btn ${allInLibrary ? 'saved' : ''}" ${allInLibrary ? 'disabled' : ''}>
                    ${allInLibrary ? '★ In Library' : '★ Add All to Library'}
                </button>
                <button class="detail-add-playlist-btn" title="Add all to playlist">
                    ♡ Add All to Playlist
                </button>
            </div>
        </div>
    `;
    
    // Wire up Add All to Library button
    const addLibBtn = detailInfo.querySelector('.detail-add-library-btn');
    if (addLibBtn && !allInLibrary) {
        addLibBtn.addEventListener('click', () => {
            addAllToLibrary(tracks);
            addLibBtn.textContent = '★ In Library';
            addLibBtn.disabled = true;
            addLibBtn.classList.add('saved');
            // Update star buttons
            detailTracks.querySelectorAll('.star-btn').forEach(btn => {
                btn.textContent = '★';
                btn.classList.add('starred');
                btn.title = 'Remove from Library';
            });
        });
    }

    // Wire up Add All to Playlist button
    const addPlaylistBtn = detailInfo.querySelector('.detail-add-playlist-btn');
    if (addPlaylistBtn && tracks.length > 0) {
        addPlaylistBtn.addEventListener('click', () => {
            if (typeof openAddToPlaylistModal === 'function') {
                openAddToPlaylistModal(tracks);
            }
        });
    }
    
    // Render tracks with download button (and delete for user playlists)
    detailTracks.innerHTML = tracks.map((t, i) => {
        const isStarred = isInLibrary(t.id);
        return `
        <div class="track-item" data-index="${i}" data-track-id="${t.id}">
            <img class="track-album-art" src="${t.album_art || image}" alt="Art" loading="lazy">
            <div class="track-info">
                <p class="track-name">${escapeHtml(t.name)}</p>
                <p class="track-artist">${escapeHtml(t.artists)}</p>
            </div>
            
            <div class="track-actions">
                ${renderDJBadgeForTrack(t)}
                <span class="track-duration">${t.duration}</span>
                <button class="star-btn ${isStarred ? 'starred' : ''}" data-track-id="${t.id}" title="${isStarred ? 'Remove from Library' : 'Add to Library'}">${isStarred ? '★' : '☆'}</button>
                <button class="playlist-btn" title="Add to Playlist" onclick="event.stopPropagation(); if(typeof window.openAddToPlaylistModal === 'function') window.openAddToPlaylistModal(JSON.parse(decodeURIComponent('${encodeURIComponent(JSON.stringify(t)).replace(/'/g, "%27")}')))">♡</button>
                <button class="download-btn" title="Download" onclick="event.stopPropagation(); openDownloadModal('${encodeURIComponent(JSON.stringify(t)).replace(/'/g, "%27")}')">
                    ⬇
                </button>
                ${isUserPlaylist ? `
                <button class="delete-track-btn" title="Remove from playlist" onclick="event.stopPropagation(); deleteFromPlaylist('${item.id}', '${t.id}')">
                    ✕
                </button>
                ` : ''}
            </div>
        </div>
    `}).join('');
    
    // Show detail view
    detailView.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    
    if (state.djMode && tracks.length > 0) {
        fetchAudioFeaturesForTracks(tracks);
    }
}

// ========== SERVICE WORKER ==========
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
}

// Save podcast/audiobook resume position before tab close or refresh
window.addEventListener('beforeunload', () => {
    try {
        const currentTrack = state.queue && state.queue[state.currentIndex];
        if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
            const player = document.getElementById('audio-player');
            const player2 = document.getElementById('audio-player-2');
            const activeP = (player && !player.paused) ? player : (player2 && !player2.paused) ? player2 : player;
            if (activeP && activeP.currentTime > 5) {
                saveEpisodePosition(currentTrack.id, activeP.currentTime);
            }
        }
    } catch (e) { /* ignore errors during unload */ }
});

// Initial state
showEmptyState();

// ========== PLAYBACK ==========
function playTrack(track) {
    if (!track || !track.id) {
        console.error("playTrack called with invalid track:", track);
        return;
    }
    // Add to queue if not already there
    const existingIndex = state.queue.findIndex(t => t && t.id === track.id);
    if (existingIndex === -1) {
        state.queue.push(track);
        state.currentIndex = state.queue.length - 1;
    } else {
        state.currentIndex = existingIndex;
    }
    
    // Podcast / Audiobook: add to history and check for resume position
    if (track.source === 'podcast' || track.source === 'audiobook') {
        if (track.source === 'audiobook') { addToAudiobookHistory(track); } else { addToPodcastHistory(track); }
        const savedPos = getEpisodePosition(track.id);
        if (savedPos > 10) {
            // Show a toast with resume option
            const resumeMin = Math.floor(savedPos / 60);
            const resumeSec = savedPos % 60;
            showToast(`▶️ Resuming from ${resumeMin}:${String(resumeSec).padStart(2, '0')}`);
            // We'll seek after the track loads
            track._resumeAt = savedPos;
        }
    }
    
    updateQueueUI();
    
    // Check if this track is already preloaded and ready - use it directly!
    if (preloadedTrackId === track.id && preloadedReady && preloadedPlayer) {
        console.log('Using preloaded track:', track.name);
        
        // Reset preload state
        preloadedTrackId = null;
        preloadedReady = false;
        
        // Update all UI
        updatePlayerUI();
        updateFullscreenUI(track);
        
        // Switch to preloaded player
        if (crossfadeEnabled) {
            performCrossfade();
        } else {
            performGaplessSwitch();
        }
        
        // Update format badge
        updateFormatBadge(getActivePlayer().src);
        
        // Preload the next one
        setTimeout(preloadNextTrack, 500);
        return;
    }
    
    loadTrack(track);
}

// ========== ALBUM ART COLOR EXTRACTION ==========
function extractDominantColor(imageUrl) {
    // Create an image to load the album art
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Allow cross-origin images
    
    img.onload = () => {
        try {
            // Create a small canvas for sampling
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const sampleSize = 10; // Sample at 10x10 for performance
            canvas.width = sampleSize;
            canvas.height = sampleSize;
            
            // Draw the scaled-down image
            ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
            
            // Get pixel data
            const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
            const pixels = imageData.data;
            
            // Calculate average color (excluding very dark/light pixels)
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                const pr = pixels[i], pg = pixels[i + 1], pb = pixels[i + 2];
                const brightness = (pr + pg + pb) / 3;
                
                // Skip very dark or very light pixels
                if (brightness > 30 && brightness < 220) {
                    r += pr;
                    g += pg;
                    b += pb;
                    count++;
                }
            }
            
            if (count > 0) {
                r = Math.round(r / count);
                g = Math.round(g / count);
                b = Math.round(b / count);
                
                // Apply to player section as a subtle gradient
                const playerSection = $('.player-section');
                if (playerSection) {
                    playerSection.style.background = `linear-gradient(180deg, rgba(${r}, ${g}, ${b}, 0.15) 0%, var(--bg-primary) 100%)`;
                }
            }
        } catch (e) {
            // Canvas tainted or other error - silently ignore
            console.log('Could not extract color from album art');
        }
    };
    
    img.onerror = () => {
        // Reset to default if image fails
        const playerSection = $('.player-section');
        if (playerSection) {
            playerSection.style.background = '';
        }
    };
    
    img.src = imageUrl;
}

function updatePlayerUI() {
    if (state.currentIndex < 0 || !state.queue[state.currentIndex]) return;
    const track = state.queue[state.currentIndex];
    
    // Basic Info
    playerBar.classList.remove('hidden');
    playerTitle.textContent = track.name;
    playerArtist.textContent = track.artists || '-';
    
    // Update visualizer info if active (Immersive Mode support)
    if (visualizerActive && typeof showVisualizerInfoBriefly === 'function') {
        showVisualizerInfoBriefly();
    }
    
    // Album name (clickable to open album)
    if (playerAlbum) {
        playerAlbum.textContent = track.album || '-';
        playerAlbum.dataset.albumId = track.album_id || '';
        playerAlbum.dataset.albumName = track.album || '';
    }
    
    // Release year only (extract from YYYY-MM-DD)
    if (playerYear) {
        const year = track.release_date ? track.release_date.slice(0, 4) : '';
        playerYear.textContent = year ? `(${year})` : '';
    }
    
    playerArt.src = track.album_art || '/static/icon.svg';
    
    // Extract dominant color for player background
    if (track.album_art) {
        extractDominantColor(track.album_art);
    }

    // DJ Mode Info
    const playerDJInfo = $('#player-dj-info');
    if (state.djMode && playerDJInfo) {
        // Use embedded audio_features for local tracks, cache for others
        const isLocal = track.id?.startsWith('local_');
        const feat = isLocal ? track.audio_features : state.audioFeaturesCache[track.id];
        
        if (feat) {
            const camelotClass = feat.camelot ? `camelot-${feat.camelot}` : '';
            playerDJInfo.innerHTML = `
                <div class="dj-badge-container" style="display: flex;">
                    <span class="dj-badge bpm-badge">${feat.bpm} BPM</span>
                    <span class="dj-badge camelot-badge ${camelotClass}">${feat.camelot}</span>
                </div>
            `;
            playerDJInfo.classList.remove('hidden');
        } else {
            // If active track is missing features, fetch them (debounce/check logic needed to avoid loop?)
            // fetchAudioFeaturesForTracks([track]); // Avoiding loop, fetch should handle it
            playerDJInfo.innerHTML = '<div class="dj-badge-placeholder"></div>';
            playerDJInfo.classList.remove('hidden');
        }
    } else if (playerDJInfo) {
        playerDJInfo.classList.add('hidden');
    }
    
    // Update Mini Player
    if (pipWindow) updateMiniPlayer();
}

// Update audio format badge (FLAC/MP3)
async function updateFormatBadge(audioSrc) {
    const badge = document.getElementById('audio-format-badge');
    const speedBtn = document.getElementById('playback-speed-btn');
    if (!badge) return;
    
    // For local files, show nothing
    if (!audioSrc || audioSrc.startsWith('blob:') || audioSrc.startsWith('file:')) {
        badge.classList.add('hidden');
        if (speedBtn) speedBtn.classList.add('hidden');
        return;
    }
    
    // Get current track source to determine actual quality
    const currentTrack = state.queue[state.currentIndex];
    const source = currentTrack?.source || '';

    // Playback Speed Logic for Podcasts and Audiobooks
    if (speedBtn) {
        if (source === 'podcast' || source === 'audiobook') {
            speedBtn.classList.remove('hidden');
            speedBtn.textContent = state.playbackSpeed.toFixed(1) + 'x';
            if (audioPlayer) audioPlayer.playbackRate = state.playbackSpeed;
            if (audioPlayer2) audioPlayer2.playbackRate = state.playbackSpeed;
        } else {
            speedBtn.classList.add('hidden');
            if (audioPlayer) audioPlayer.playbackRate = 1.0;
            if (audioPlayer2) audioPlayer2.playbackRate = 1.0;
        }
    }

    badge.classList.remove('hidden', 'mp3', 'flac', 'hi-res');
    
    // Attempt to get accurate quality from headers via HEAD request
    let headersDetermined = false;
    if (audioSrc && audioSrc.includes('/api/stream/')) {
        try {
            // Strip any hash (like #t=10)
            const headUrl = audioSrc.split('#')[0];
            const response = await fetch(headUrl, { method: 'HEAD' });
            if (response.ok) {
                const audioFormat = response.headers.get('X-Audio-Format');
                const audioQuality = response.headers.get('X-Audio-Quality');
                const contentType = response.headers.get('Content-Type');
                
                if (audioFormat === 'FLAC') {
                    badge.classList.add('flac');
                    if (audioQuality === 'Hi-Res') {
                        badge.classList.add('hi-res');
                        badge.textContent = 'HI-RES';
                    } else {
                        badge.textContent = 'HIFI';
                    }
                    headersDetermined = true;
                } else if (contentType && (contentType.includes('mpeg') || contentType.includes('mp3') || contentType.includes('mp4') || contentType.includes('aac'))) {
                    badge.classList.add('mp3');
                    if (contentType.includes('mp4') || source === 'audiobook') {
                        badge.textContent = 'M4B';
                    } else {
                        badge.textContent = 'MP3';
                    }
                    headersDetermined = true;
                }
            }
        } catch (e) {
            console.log('Failed to fetch stream headers for badge', e);
        }
    }
    
    // Fallback to guessing based on source if headers failed or it's a direct URL
    if (!headersDetermined) {
        const isHiResSource = source === 'dab' || source === 'qobuz' || source === 'tidal';
        const isHiFiSource = source === 'deezer' || source === 'jamendo';
        const isLossySource = source === 'ytmusic' || source === 'youtube' || source === 'podcast' || source === 'import';
        
        if (isHiResSource && state.hiResMode) {
            badge.classList.add('flac', 'hi-res');
            badge.textContent = 'HI-RES';
        } else if (isHiResSource || isHiFiSource) {
            badge.classList.add('flac');
            badge.textContent = 'HIFI';
        } else if (isLossySource) {
            badge.classList.add('mp3');
            if (source === 'audiobook') badge.textContent = 'M4B';
            else badge.textContent = 'MP3';
        } else {
            badge.classList.add('flac');
            if (state.hiResMode) {
                badge.classList.add('hi-res');
                badge.textContent = 'HI-RES';
            } else {
                badge.textContent = 'HIFI';
            }
        }
    }
    
    // Also update the HiFi button in header
    if (typeof updateHifiButtonUI === 'function') {
        updateHifiButtonUI();
    }
}

// Player artist/album click handlers for discovery
if (playerArtist) {
    playerArtist.addEventListener('click', () => {
        const artistName = playerArtist.textContent;
        if (artistName && artistName !== '-') {
            state.searchType = 'artist';
            document.querySelectorAll('.type-btn, .type-btn-menu').forEach(b => b.classList.remove('active'));
            const artistBtn = document.querySelector('[data-type="artist"]');
            if (artistBtn) artistBtn.classList.add('active');
            searchInput.value = artistName;
            performSearch(artistName);
        }
    });
}

if (playerAlbum) {
    playerAlbum.addEventListener('click', () => {
        const albumId = playerAlbum.dataset.albumId;
        if (albumId) {
            openAlbum(albumId);
        }
    });
}

// Track load state to prevent duplicates
let loadInProgress = false;
let loadTimeoutId = null;
let consecutiveFailures = 0; // Auto-skip counter
const MAX_CONSECUTIVE_FAILURES = 5;

async function loadTrack(track) {
    // Prevent duplicate loads
    if (loadInProgress) {
        console.log('Load already in progress, skipping duplicate load for:', track.name);
        return;
    }
    
    loadInProgress = true;
    showLoading(`Loading "${track.name}"...`);
    state.scrobbledCurrent = false; // Reset scrobble status
    playerBar.classList.remove('hidden');
    
    // Podcast/Audiobook: auto-check resume position if not already set
    // This ensures resume works regardless of which code path called loadTrack
    if (track.source === 'podcast' || track.source === 'audiobook') {
        if (!track._resumeAt) {
            const savedPos = getEpisodePosition(track.id);
            if (savedPos > 10) {
                const resumeMin = Math.floor(savedPos / 60);
                const resumeSec = Math.floor(savedPos % 60);
                showToast(`▶️ Resuming from ${resumeMin}:${String(resumeSec).padStart(2, '0')}`);
                track._resumeAt = savedPos;
            }
        }
        if (track.source === 'audiobook') { addToAudiobookHistory(track); } else { addToPodcastHistory(track); }
    }
    
    // Reset preload and transition state on direct track load
    preloadedTrackId = null;
    preloadedPlayer = null;
    preloadedReady = false;
    transitionInProgress = false;
    if (crossfadeTimeout) {
        clearTimeout(crossfadeTimeout);
        crossfadeTimeout = null;
    }
    
    // Clear any existing load timeout
    if (loadTimeoutId) {
        clearTimeout(loadTimeoutId);
        loadTimeoutId = null;
    }
    
    updatePlayerUI();
    updateQueueUI();
    updateFullscreenUI(track); // Sync FS
    
    // Get the active player
    const player = getActivePlayer();
    const playerGain = activePlayer === 1 ? gainNode1 : gainNode2;
    
    // Make sure active player gain is at 1
    if (playerGain) playerGain.gain.value = 1;
    
    // For ListenBrainz tracks, try to enrich with album art from search
    if (track.source === 'listenbrainz' && track.album_art === '/static/icon.svg') {
        try {
            const searchQuery = track.artists + ' ' + track.name;
            const searchRes = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=1`);
            const searchData = await searchRes.json();
            if (searchData.results && searchData.results.length > 0) {
                const foundTrack = searchData.results[0];
                if (foundTrack.album_art && foundTrack.album_art !== '/static/icon.svg') {
                    track.album_art = foundTrack.album_art;
                    console.log('Enriched LB track with album art:', foundTrack.album_art);
                    updatePlayerUI(); // Refresh the player bar with new art
                    updateFullscreenUI(track);
                }
            }
        } catch (e) {
            console.log('Could not enrich LB track art:', e);
        }
    }
    
    // Play
    if (track.is_local && track.src) {
        let baseSrc = track.src;
        if (track._resumeAt && track._resumeAt > 10) {
            baseSrc += `#t=${track._resumeAt}`;
            delete track._resumeAt;
        }
        player.src = baseSrc;
    } else {
        const hiresParam = state.hiResMode ? '&hires=true' : '&hires=false';
        const qualityParam = state.hiResMode ? `&hires_quality=${state.hiResQuality}` : '';
        const sourceParam = track.source ? `&source=${track.source}` : '';
        let targetSrc = `/api/stream/${track.isrc || track.id}?q=${encodeURIComponent(track.name + ' ' + track.artists)}${hiresParam}${qualityParam}${sourceParam}`;
        
        if (track._resumeAt && track._resumeAt > 10) {
            targetSrc += `#t=${track._resumeAt}`;
            delete track._resumeAt;
        }
        player.src = targetSrc;
    }
    
    try {
        state.lastSavedPositionTime = 0; // Reset tracking timestamp
        player.load();
        
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                player.oncanplay = null;
                player.onerror = null;
                player.onloadedmetadata = null;
                if (loadTimeoutId) {
                    clearTimeout(loadTimeoutId);
                    loadTimeoutId = null;
                }
            };
            
            player.onloadedmetadata = () => {
                // Metadata loaded
            };
            
            // Use canplay instead of canplaythrough for faster start
            player.oncanplay = () => {
                cleanup();
                resolve();
            };
            player.onerror = () => {
                cleanup();
                reject(new Error('Failed to load audio'));
            };
            // Increased timeout to 35s to allow for Premiumize proxies to restart range requests
            loadTimeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout loading audio'));
            }, 35000);
        });
        
        // Success — reset consecutive failure counter
        consecutiveFailures = 0;
        
        hideLoading();
        player.play();
        state.isPlaying = true;
        updatePlayButton();
        updateMediaSession(track);
        
        // Track listening history
        addToHistory(track);
        
        // Detect audio format and update badge
        updateFormatBadge(player.src);
        
    } catch (error) {
        console.error('Playback error:', error);
        hideLoading();
        consecutiveFailures++;
        
        // Auto-skip to next track if there are more in the queue
        if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES && state.currentIndex < state.queue.length - 1) {
            console.log(`Auto-skipping failed track (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${track.name}`);
            showToast(`Skipping "${track.name}" — failed to load`, 'warning');
            loadInProgress = false; // Must reset before calling playNext
            playNext();
            return;
        } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            showError(`Unable to play — ${consecutiveFailures} tracks failed in a row. Please check your connection.`);
            consecutiveFailures = 0;
        } else {
            showError('Failed to load track. No more tracks in queue.');
        }
    } finally {
        loadInProgress = false;
    }
}

// Player controls
playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', playPrevious);
if (miniPlayerBtn) miniPlayerBtn.addEventListener('click', toggleMiniPlayer);
nextBtn.addEventListener('click', playNext);

const playbackSpeedBtn = document.getElementById('playback-speed-btn');
if (playbackSpeedBtn) {
    playbackSpeedBtn.addEventListener('click', () => {
        const speeds = [1.0, 1.25, 1.5, 2.0];
        const currentIdx = speeds.indexOf(state.playbackSpeed) !== -1 ? speeds.indexOf(state.playbackSpeed) : 0;
        state.playbackSpeed = speeds[(currentIdx + 1) % speeds.length];
        
        playbackSpeedBtn.textContent = state.playbackSpeed.toFixed(1) + 'x';
        
        if (audioPlayer) audioPlayer.playbackRate = state.playbackSpeed;
        if (audioPlayer2) audioPlayer2.playbackRate = state.playbackSpeed;
    });
}


// Shuffle current queue
shuffleQueueBtn.addEventListener('click', () => {
    if (state.queue.length <= 1) return;
    
    // Get currently playing track
    const currentTrack = state.queue[state.currentIndex];
    
    // Remove current track from queue temporarily
    const otherTracks = state.queue.filter((_, i) => i !== state.currentIndex);
    
    // Shuffle the other tracks using Fisher-Yates
    for (let i = otherTracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [otherTracks[i], otherTracks[j]] = [otherTracks[j], otherTracks[i]];
    }
    
    // Put current track at front, add shuffled tracks after
    state.queue = [currentTrack, ...otherTracks];
    state.currentIndex = 0;
    
    updateQueueUI();
    
    // Visual feedback
    shuffleQueueBtn.style.transform = 'scale(1.2)';
    setTimeout(() => shuffleQueueBtn.style.transform = '', 200);
});

function togglePlay() {
    const player = getActivePlayer();
    
    // Check if player has source logic (for refresh case)
    if (!player.src && state.queue.length > 0 && state.currentIndex >= 0) {
        // Queue exists but nothing loaded yet (refresh case)
        loadTrack(state.queue[state.currentIndex]);
        return;
    }
    
    if (player.paused) {
        player.play().catch(e => {
            console.warn('Play failed:', e);
            // Try resuming AudioContext first (common on mobile after screen lock)
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume().then(() => player.play().catch(() => {}));
            }
        });
    } else {
        player.pause();
    }
}

function playNext() {
    // Guard against race conditions - if gapless transition is already handling this, skip
    if (transitionInProgress) {
        console.log('playNext: Transition already in progress, skipping to prevent double-trigger');
        return;
    }
    
    const currentTrack = state.queue[state.currentIndex];
    const player = getActivePlayer();
    // Podcast/Audiobook: seek +15s instead of next track
    if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
        player.currentTime = Math.min(player.duration || 0, player.currentTime + 15);
        return;
    }
    
    // Repeat One: restart current track
    if (state.repeatMode === 'one') {
        player.currentTime = 0;
        player.play();
        return;
    }
    
    if (state.currentIndex < state.queue.length - 1) {
        state.currentIndex++;
        state.scrobbledCurrent = false;
        
        // Try to use preloaded player (no loading screen) - ONLY if ready
        if (preloadedReady && preloadedPlayer && preloadedTrackId === state.queue[state.currentIndex]?.id) {
            console.log('playNext: Using preloaded player for:', state.queue[state.currentIndex].name);
            preloadedTrackId = null;
            preloadedReady = false;
            updatePlayerUI();
            updateQueueUI();
            updateFullscreenUI(state.queue[state.currentIndex]);
            if (crossfadeEnabled) {
                performCrossfade();
            } else {
                performGaplessSwitch();
            }
            updateFormatBadge(getActivePlayer().src);
            updateMediaSession(state.queue[state.currentIndex]);
            addToHistory(state.queue[state.currentIndex]);
            requestAnimationFrame(() => preloadNextTrack());
        } else {
            loadTrack(state.queue[state.currentIndex]);
        }
    } else if (state.repeatMode === 'all' && state.queue.length > 0) {
        // Repeat All: loop back to start
        state.currentIndex = 0;
        state.scrobbledCurrent = false;
        loadTrack(state.queue[0]);
    }
    // else: end of queue with no repeat — do nothing (stop naturally)
}

function playPrevious() {
    const currentTrack = state.queue[state.currentIndex];
    const player = getActivePlayer();
    // Podcast/Audiobook: seek -15s instead of prev track
    if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
        player.currentTime = Math.max(0, player.currentTime - 15);
        return;
    }
    if (player.currentTime > 3) {
        player.currentTime = 0;
    } else if (state.currentIndex > 0) {
        state.currentIndex--;
        loadTrack(state.queue[state.currentIndex]);
    }
}

// Shared event handlers for both audio players
function handlePlay() {
    state.isPlaying = true;
    updatePlayButton();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    const track = state.queue[state.currentIndex];
    if (track) submitNowPlaying(track);
}

function handlePause(e) {
    // Only update if the active player paused
    if (e.target === getActivePlayer()) {
        state.isPlaying = false;
        updatePlayButton();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        
        // Immediately save resume position for podcasts/audiobooks on pause
        const currentTrack = state.queue[state.currentIndex];
        const player = getActivePlayer();
        if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
            if (player.currentTime > 5) {
                saveEpisodePosition(currentTrack.id, player.currentTime);
                console.log(`Saved resume position on pause: ${currentTrack.name} @ ${Math.floor(player.currentTime)}s`);
            }
        }
    }
}

function handleProgress() {
    const player = getActivePlayer();
    if (player.duration > 0 && player.buffered.length > 0) {
        // Check if we have buffered enough to start next download
        const bufferedEnd = player.buffered.end(player.buffered.length - 1);
        if (bufferedEnd >= player.duration - 60) { // 60 seconds before end (for long songs)
             preloadNextTrack();
        }
    }
}

// Unified ended handler — handles repeat, transition guards, and queue advancement
function handleEnded(e) {
    // Skip if gapless transition is actively in progress
    if (transitionInProgress) {
        console.log('handleEnded: Skipping playNext (transition in progress)');
        return;
    }
    // Clear stale crossfade guard — timer may have been frozen by Android background throttling
    if (crossfadeTimeout) {
        clearTimeout(crossfadeTimeout);
        crossfadeTimeout = null;
        console.log('handleEnded: Cleared stale crossfadeTimeout (was frozen in background)');
    }
    // Only respond if the active player fired this event
    if (e.target !== getActivePlayer()) return;
    
    // Podcast/Audiobook: auto-mark as played and clear resume position
    const currentTrack = state.queue[state.currentIndex];
    if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
        markEpisodePlayed(currentTrack.id);
        clearEpisodePosition(currentTrack.id);
    }
    
    playNext();
}

// Bind events to both players
audioPlayer.addEventListener('play', handlePlay);
audioPlayer2.addEventListener('play', handlePlay);
audioPlayer.addEventListener('pause', handlePause);
audioPlayer2.addEventListener('pause', handlePause);
audioPlayer.addEventListener('progress', handleProgress);
audioPlayer2.addEventListener('progress', handleProgress);
audioPlayer.addEventListener('ended', handleEnded);
audioPlayer2.addEventListener('ended', handleEnded);

// ========== STALL RECOVERY ==========
let stallRecoveryTimer = null;
let waitingWatchdog = null;

function handleStalled(e) {
    if (e.target !== getActivePlayer()) return;
    console.warn('Audio stream stalled — starting 10s recovery timer');
    
    // Clear any existing recovery timer
    if (stallRecoveryTimer) clearTimeout(stallRecoveryTimer);
    
    stallRecoveryTimer = setTimeout(() => {
        const player = getActivePlayer();
        if (player.paused || player.ended) return; // Not actually playing
        
        // Try to recover by seeking to current position (forces reconnect)
        const currentPos = player.currentTime;
        console.warn('Stall recovery: seeking to', currentPos, 'to force reconnect');
        player.currentTime = currentPos;
        
        // If still stalled after another 10s, auto-skip
        stallRecoveryTimer = setTimeout(() => {
            if (!player.paused && player.readyState < 3) {
                console.warn('Stall unrecoverable — auto-skipping');
                showToast('Stream stalled — skipping to next track', 'warning');
                playNext();
            }
        }, 10000);
    }, 10000);
}

function handleWaiting(e) {
    if (e.target !== getActivePlayer()) return;
    // Set a watchdog — if we're still waiting after 15s, try recovery
    if (waitingWatchdog) clearTimeout(waitingWatchdog);
    waitingWatchdog = setTimeout(() => {
        const player = getActivePlayer();
        if (!player.paused && player.readyState < 3) {
            console.warn('Waiting watchdog triggered — attempting seek recovery');
            player.currentTime = player.currentTime; // Force reconnect
        }
    }, 15000);
}

function handlePlaying(e) {
    // Clear stall/waiting timers when playback resumes
    if (stallRecoveryTimer) { clearTimeout(stallRecoveryTimer); stallRecoveryTimer = null; }
    if (waitingWatchdog) { clearTimeout(waitingWatchdog); waitingWatchdog = null; }
}

audioPlayer.addEventListener('stalled', handleStalled);
audioPlayer2.addEventListener('stalled', handleStalled);
audioPlayer.addEventListener('waiting', handleWaiting);
audioPlayer2.addEventListener('waiting', handleWaiting);
audioPlayer.addEventListener('playing', handlePlaying);
audioPlayer2.addEventListener('playing', handlePlaying);

audioPlayer.addEventListener('timeupdate', handleTimeUpdate);
audioPlayer2.addEventListener('timeupdate', handleTimeUpdate);

function handleTimeUpdate() {
    // Update Mini Player Time
    if (pipWindow) updateMiniPlayer();

    const player = getActivePlayer();
    if (player.duration) {
        currentTime.textContent = formatTime(player.currentTime);
        duration.textContent = formatTime(player.duration);
        progressBar.value = (player.currentTime / player.duration) * 100;
        
        // Sync FS Progress
        fsCurrentTime.textContent = currentTime.textContent;
        fsDuration.textContent = duration.textContent;
        fsProgressBar.value = progressBar.value;
        
        // Update CSS variable for gradient fill
        progressBar.style.setProperty('--value', progressBar.value + '%');
        fsProgressBar.style.setProperty('--value', progressBar.value + '%');
        
        // Scrobble Check (50% or 4 mins)
        if (!state.scrobbledCurrent && state.queue[state.currentIndex]) {
            if (player.currentTime > 240 || player.currentTime > player.duration / 2) {
                submitScrobble(state.queue[state.currentIndex]);
            }
        }
        
        // Podcast/Audiobook: save resume position every 10 seconds
        const currentTrack = state.queue[state.currentIndex];
        if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
            if (player.currentTime > 5 && player.currentTime > state.lastSavedPositionTime + 10) {
                saveEpisodePosition(currentTrack.id, player.currentTime);
                state.lastSavedPositionTime = player.currentTime;
            }
        }
        
        // Time-based preload trigger (1 minute before end - better for long songs)
        const timeRemaining = player.duration - player.currentTime;
        if (timeRemaining <= 60 && timeRemaining > 0 && !preloadedTrackId) {
            preloadNextTrack();
        }
        
        // Crossfade/Gapless trigger: start transition before track ends
        const crossfadeTime = crossfadeEnabled ? CROSSFADE_DURATION / 1000 : 0.2;
        
        // Trigger playNext if preloaded player is ready and we're near the end
        if (timeRemaining <= crossfadeTime && timeRemaining > 0 && preloadedPlayer && !crossfadeTimeout && !transitionInProgress) {
            // Set crossfadeTimeout guard to prevent handleEnded from also firing playNext
            // Do NOT set transitionInProgress here — playNext needs it to be false to proceed
            crossfadeTimeout = setTimeout(() => {
                crossfadeTimeout = null;
            }, crossfadeTime * 1000 + 1000);
            playNext();
        }
    }
}

progressBar.addEventListener('input', (e) => {
    const player = getActivePlayer();
    if (player.duration && Number.isFinite(player.duration)) {
        player.currentTime = (e.target.value / 100) * player.duration;
        e.target.style.setProperty('--value', e.target.value + '%');
        if (typeof fsProgressBar !== 'undefined') fsProgressBar.style.setProperty('--value', e.target.value + '%');
    }
});

function updatePlayButton() {
    playBtn.textContent = state.isPlaying ? '⏸' : '▶';
    if (typeof updateFSPlayBtn === 'function') updateFSPlayBtn();
}

// ========== QUEUE ==========
// queueClose and queueClear are defined at top level

// ...

queueBtn.addEventListener('click', () => {
    queueSection.classList.toggle('hidden');
});

queueClose.addEventListener('click', () => {
    queueSection.classList.add('hidden');
});

queueClear.addEventListener('click', () => {
    state.queue = [];
    state.currentIndex = -1;
    updateQueueUI();
});

// Queue Download Button
$('#queue-download-btn')?.addEventListener('click', () => {
    if (state.queue.length === 0) return;
    
    // Get checked queue items
    const checkedIndices = new Set();
    document.querySelectorAll('#queue-container .queue-select-cb:checked').forEach(cb => {
        checkedIndices.add(parseInt(cb.dataset.index));
    });
    
    // Filter queue to get selected tracks
    const selectedTracks = state.queue.filter((_, i) => checkedIndices.has(i));
    
    if (selectedTracks.length === 0) {
        showToast('Please select at least one track to download');
        return;
    }
    
    isBatchDownload = true;
    trackToDownload = null;
    state.detailTracks = selectedTracks;
    downloadTrackName.textContent = `Queue Selection (${selectedTracks.length} tracks)`;
    downloadModal.classList.remove('hidden');
    // Don't close queue section so user maintains context
});

// Delegated click handler for queue items (handles play, remove, and add-to-playlist)
queueContainer.addEventListener('click', (e) => {
    // Check if clicked on checkbox - prevent triggering play
    if (e.target.classList.contains('queue-select-cb')) {
        e.stopPropagation();
        return;
    }
    
    // Check if clicked on remove button
    const removeBtn = e.target.closest('.queue-remove-btn');
    if (removeBtn) {
        e.stopPropagation();
        const index = parseInt(removeBtn.dataset.index, 10);
        window.removeFromQueue(index);
        return;
    }
    
    // Check if clicked on heart button (add to playlist)
    const heartBtn = e.target.closest('.queue-heart-btn');
    if (heartBtn) {
        e.stopPropagation();
        const index = parseInt(heartBtn.dataset.index, 10);
        const track = state.queue[index];
        if (track && window.openAddToPlaylistModal) {
            window.openAddToPlaylistModal(track);
        }
        return;
    }
    
    // Check if clicked on queue item (to play)
    const queueItem = e.target.closest('.queue-item');
    if (queueItem) {
        const index = parseInt(queueItem.dataset.index, 10);
        state.currentIndex = index;
        loadTrack(state.queue[index]);
    }
});

// ========== QUEUE PERSISTENCE ==========
function saveQueueToStorage() {
    try {
        // Save queue and current index
        const queueData = {
            queue: state.queue,
            currentIndex: state.currentIndex
        };
        localStorage.setItem('freedify_queue', JSON.stringify(queueData));
    } catch (e) {
        console.warn('Could not save queue to storage:', e);
    }
}

function loadQueueFromStorage() {
    try {
        const saved = localStorage.getItem('freedify_queue');
        if (saved) {
            const queueData = JSON.parse(saved);
            if (queueData.queue && Array.isArray(queueData.queue) && queueData.queue.length > 0) {
                state.queue = queueData.queue;
                state.currentIndex = queueData.currentIndex || 0;
                updateQueueUI();
                // Load the track but don't auto-play
                if (state.queue[state.currentIndex]) {
                    updatePlayerUI();
                }
                console.log(`Restored queue: ${state.queue.length} tracks`);
            }
        }
    } catch (e) {
        console.warn('Could not load queue from storage:', e);
    }
}

function updateQueueUI() {
    queueCount.textContent = `(${state.queue.length})`;
    
    // Persist queue to localStorage
    saveQueueToStorage();
    
    if (state.queue.length === 0) {
        queueContainer.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);padding:24px;">Queue is empty</p>';
        return;
    }
    
    queueContainer.innerHTML = state.queue.filter(t => t).map((track, i) => `
        <div class="queue-item" data-index="${i}">
            <input type="checkbox" class="queue-select-cb" data-index="${i}" title="Select for download">
            <img class="track-album-art" src="${track.album_art || '/static/icon.svg'}" alt="Art" style="width:40px;height:40px;">
            <div class="track-info">
                <p class="track-name" style="font-size:0.875rem;">${escapeHtml(track.name || 'Unknown')}</p>
                <p class="track-artist">${escapeHtml(track.artists || '')}</p>
            </div>
            <button class="queue-heart-btn" data-action="add-to-playlist" data-index="${i}" title="Add to Playlist">🩷</button>
            <button class="queue-remove-btn" data-action="remove" data-index="${i}" title="Remove">×</button>
        </div>
    `).join('');
    
    // Mark currently playing and scroll into view
    const currentEl = queueContainer.querySelector(`[data-index="${state.currentIndex}"]`);
    if (currentEl) {
        currentEl.classList.add('playing');
        currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ========== PRELOADING ==========
let preloadedTrackId = null;
let transitionInProgress = false; // Prevents race condition between gapless switch and ended event

function preloadNextTrack() {
    if (state.currentIndex === -1 || state.currentIndex >= state.queue.length - 1) return;
    
    const nextTrack = state.queue[state.currentIndex + 1];
    if (!nextTrack || nextTrack.id === preloadedTrackId) return;
    
    preloadedTrackId = nextTrack.id;
    preloadedReady = false; // Reset ready flag
    console.log('Preloading next track into inactive player:', nextTrack.name);
    
    const query = `${nextTrack.name} ${nextTrack.artists}`;
    const hiresParam = state.hiResMode ? '&hires=true' : '&hires=false';
    const qualityParam = state.hiResMode ? `&hires_quality=${state.hiResQuality}` : '';
    const sourceParam = nextTrack.source ? `&source=${nextTrack.source}` : '';
    const streamUrl = `/api/stream/${nextTrack.isrc || nextTrack.id}?q=${encodeURIComponent(query)}${hiresParam}${qualityParam}${sourceParam}`;
    
    // Load into the inactive player for gapless transition
    const inactivePlayer = activePlayer === 1 ? audioPlayer2 : audioPlayer;
    
    // Set up canplaythrough listener for reliable ready detection
    const onReady = () => {
        preloadedReady = true;
        console.log('Preloaded track ready (canplaythrough):', nextTrack.name);
        inactivePlayer.removeEventListener('canplaythrough', onReady);
    };
    inactivePlayer.addEventListener('canplaythrough', onReady);
    
    inactivePlayer.src = streamUrl;
    inactivePlayer.load();
    preloadedPlayer = inactivePlayer;
    
    console.log('Next track loading into player', activePlayer === 1 ? 2 : 1);
}

// Get the currently active audio player
function getActivePlayer() {
    return activePlayer === 1 ? audioPlayer : audioPlayer2;
}

// Get the inactive audio player (for preloading)
function getInactivePlayer() {
    return activePlayer === 1 ? audioPlayer2 : audioPlayer;
}

// Perform crossfade between players
function performCrossfade() {
    // Capture references BEFORE switching
    const oldPlayer = activePlayer === 1 ? audioPlayer : audioPlayer2;
    const newPlayer = activePlayer === 1 ? audioPlayer2 : audioPlayer;
    const fadeOutGain = activePlayer === 1 ? gainNode1 : gainNode2;
    const fadeInGain = activePlayer === 1 ? gainNode2 : gainNode1;
    
    if (!audioContext || !fadeOutGain || !fadeInGain) return;
    
    const now = audioContext.currentTime;
    const fadeDuration = CROSSFADE_DURATION / 1000;
    
    // Switch activePlayer FIRST so handlePause ignores the old player
    activePlayer = activePlayer === 1 ? 2 : 1;
    
    // Start playing the new track
    newPlayer.play().catch(e => console.error('Crossfade play error:', e));
    
    // Crossfade: fade out current, fade in next
    fadeOutGain.gain.setValueAtTime(1, now);
    fadeOutGain.gain.linearRampToValueAtTime(0, now + fadeDuration);
    
    fadeInGain.gain.setValueAtTime(0, now);
    fadeInGain.gain.linearRampToValueAtTime(1, now + fadeDuration);
    
    // Pause old player after fade completes
    setTimeout(() => {
        oldPlayer.pause();
        oldPlayer.currentTime = 0;
    }, CROSSFADE_DURATION + 100);
    
    console.log('Crossfade to player', activePlayer);
}

// Instant gapless switch (no crossfade)
function performGaplessSwitch() {
    // Capture references BEFORE switching activePlayer
    const oldPlayer = activePlayer === 1 ? audioPlayer : audioPlayer2;
    const newPlayer = activePlayer === 1 ? audioPlayer2 : audioPlayer;
    const fadeOutGain = activePlayer === 1 ? gainNode1 : gainNode2;
    const fadeInGain = activePlayer === 1 ? gainNode2 : gainNode1;
    
    // Switch activePlayer FIRST so handlePause ignores the old player's pause event
    activePlayer = activePlayer === 1 ? 2 : 1;
    
    // Set gains
    if (fadeOutGain) fadeOutGain.gain.value = 0;
    if (fadeInGain) fadeInGain.gain.value = 1;
    
    // Start new player, then stop old
    newPlayer.play().catch(e => console.error('Gapless play error:', e));
    oldPlayer.pause();
    oldPlayer.currentTime = 0;
    
    console.log('Gapless switch to player', activePlayer);
}

// ========== UI HELPERS ==========
function showLoading(text) {
    loadingText.textContent = text || 'Loading...';
    loadingOverlay.classList.remove('hidden');
    errorMessage.classList.add('hidden');
}

function hideLoading() {
    loadingOverlay.classList.add('hidden');
}

function showError(message) {
    hideLoading();
    errorText.textContent = message;
    errorMessage.classList.remove('hidden');
}

errorRetry.addEventListener('click', () => {
    errorMessage.classList.add('hidden');
    const query = searchInput.value.trim();
    if (query) performSearch(query);
});

function showEmptyState() {
    // Check if we have any history or playlists to show
    const hasHistory = state.history && state.history.length > 0;
    const hasPlaylists = state.playlists && state.playlists.length > 0;
    const hasLibrary = state.library && state.library.length > 0;
    
    // If no data, show default empty state
    if (!hasHistory && !hasPlaylists && !hasLibrary) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">🔍</span>
                <p>Search for your favorite music</p>
                <p class="hint">Or paste a Spotify link to an album or playlist</p>
            </div>
        `;
        return;
    }
    
    // Build dashboard HTML
    let html = '<div class="dashboard">';
    
    // Section 1: Jump Back In (Recent Albums from History)
    if (hasHistory) {
        // Get unique albums from history
        const seenAlbums = new Set();
        const recentAlbums = [];
        for (const track of state.history) {
            const albumKey = track.album || track.artists;
            if (!seenAlbums.has(albumKey) && recentAlbums.length < 8) {
                seenAlbums.add(albumKey);
                recentAlbums.push(track);
            }
        }
        
        if (recentAlbums.length > 0) {
            html += `
                <section class="dashboard-section">
                    <h3 class="dashboard-title">🎵 Jump Back In</h3>
                    <div class="dashboard-grid">
                        ${recentAlbums.map(track => `
                            <div class="dashboard-card" data-track-id="${track.id}" onclick="playHistoryTrack('${track.id}')">
                                <img src="${track.album_art || '/static/icon.svg'}" alt="${escapeHtml(track.album || track.name)}" loading="lazy">
                                <div class="dashboard-card-info">
                                    <p class="dashboard-card-title">${escapeHtml(track.album || track.name)}</p>
                                    <p class="dashboard-card-subtitle">${escapeHtml(track.artists)}</p>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </section>
            `;
        }
    }
    
    // Section 2: Recent Artists
    if (hasHistory) {
        const seenArtists = new Set();
        const recentArtists = [];
        for (const track of state.history) {
            const artist = (track.artists || '').split(',')[0].trim();
            if (artist && !seenArtists.has(artist) && recentArtists.length < 6) {
                seenArtists.add(artist);
                recentArtists.push({ name: artist, art: track.album_art });
            }
        }
        
        if (recentArtists.length > 0) {
            html += `
                <section class="dashboard-section">
                    <h3 class="dashboard-title">🎤 Your Artists</h3>
                    <div class="dashboard-grid dashboard-grid-artists">
                        ${recentArtists.map(artist => `
                            <div class="dashboard-card dashboard-card-artist" onclick="searchArtist('${escapeHtml(artist.name)}')">
                                <img src="${artist.art || '/static/icon.svg'}" alt="${escapeHtml(artist.name)}" loading="lazy">
                                <div class="dashboard-card-info">
                                    <p class="dashboard-card-title">${escapeHtml(artist.name)}</p>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </section>
            `;
        }
    }
    
    // Section 3: Your Library (Starred Tracks)
    if (hasLibrary) {
        html += `
            <section class="dashboard-section">
                <h3 class="dashboard-title">⭐ Your Library <span class="dashboard-count">(${state.library.length})</span></h3>
                <div class="dashboard-grid">
                    ${state.library.slice(0, 8).map(track => `
                        <div class="dashboard-card" data-track-id="${track.id}" onclick="playHistoryTrack('${track.id}')">
                            <img src="${track.album_art || '/static/icon.svg'}" alt="${escapeHtml(track.name)}" loading="lazy">
                            <div class="dashboard-card-info">
                                <p class="dashboard-card-title">${escapeHtml(track.name)}</p>
                                <p class="dashboard-card-subtitle">${escapeHtml(track.artists)}</p>
                            </div>
                        </div>
                    `).join('')}
                </div>
                ${state.library.length > 8 ? '<button class="dashboard-see-all" onclick="showLibraryView()">See All →</button>' : ''}
            </section>
        `;
    }
    
    // Section 4: Your Playlists
    if (hasPlaylists) {
        html += `
            <section class="dashboard-section">
                <h3 class="dashboard-title">📋 Your Playlists</h3>
                <div class="dashboard-grid">
                    ${state.playlists.slice(0, 4).map(playlist => `
                        <div class="dashboard-card" onclick="openPlaylistById('${playlist.id}')">
                            <img src="${playlist.tracks[0]?.album_art || '/static/icon.svg'}" alt="${escapeHtml(playlist.name)}" loading="lazy">
                            <div class="dashboard-card-info">
                                <p class="dashboard-card-title">${escapeHtml(playlist.name)}</p>
                                <p class="dashboard-card-subtitle">${playlist.tracks.length} tracks</p>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    }
    
    html += '</div>';
    resultsContainer.innerHTML = html;
}

// Dashboard helper functions
function playHistoryTrack(trackId) {
    const track = state.history.find(t => t.id === trackId) || state.library.find(t => t.id === trackId);
    if (track) {
        state.queue = [track];
        state.currentIndex = 0;
        
        // Podcast / Audiobook: check for resume position
        if (track.source === 'podcast' || track.source === 'audiobook') {
            const savedPos = getEpisodePosition(track.id);
            if (savedPos > 10) {
                const resumeMin = Math.floor(savedPos / 60);
                const resumeSec = savedPos % 60;
                showToast(`▶️ Resuming from ${resumeMin}:${String(resumeSec).padStart(2, '0')}`);
                track._resumeAt = savedPos;
            }
        }
        
        loadTrack(track);
    }
}

function searchArtist(artistName) {
    searchInput.value = artistName;
    state.searchType = 'artist';
    performSearch(artistName);
}

function openPlaylistById(playlistId) {
    const playlist = state.playlists.find(p => p.id === playlistId);
    if (playlist) {
        showPlaylistDetail(playlist);
    }
}

function showLibraryView() {
    // Create a virtual "playlist" from library and show it
    const libraryPlaylist = {
        id: '__library__',
        name: '⭐ Your Library',
        tracks: state.library,
        is_user_playlist: true
    };
    showPlaylistDetail(libraryPlaylist);
}

// Expose for onclick
window.playHistoryTrack = playHistoryTrack;
window.searchArtist = searchArtist;
window.openPlaylistById = openPlaylistById;
window.showLibraryView = showLibraryView;

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    seconds = Math.floor(seconds); 
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// ========== SERVICE WORKER ==========

// ========== FULLSCREEN PLAYER & EXTRAS ==========

window.removeFromQueue = function(index) {
    if (index === state.currentIndex) {
        // Removing currently playing
        state.queue.splice(index, 1);
        if (state.queue.length === 0) {
            getActivePlayer().pause();
            state.isPlaying = false;
            updatePlayButton();
            state.currentIndex = -1;
            // updatePlayerUI({ name: 'No track playing', artists: '-', album_art: '' }); // Reset UI
            playerTitle.textContent = 'No track playing';
            playerArtist.textContent = '-';
            playerArt.src = '';
            // Reset FS
            fsTitle.textContent = 'No track playing';
            fsArtist.textContent = 'Select music';
        } else {
             // If we remove last item
             if (index >= state.queue.length) {
                 state.currentIndex = 0; 
                 loadTrack(state.queue[0]);
             } else {
                 // Index stays same (next track shifted into it)
                 playTrack(state.queue[index]);
             }
        }
    } else {
        // Removing other track
        state.queue.splice(index, 1);
        if (index < state.currentIndex) {
            state.currentIndex--;
        }
        updateQueueUI();
    }
};

function toggleFullScreen() {
    fullscreenPlayer.classList.toggle('hidden');
    if (!fullscreenPlayer.classList.contains('hidden')) {
        if (state.currentIndex >= 0) {
            updateFullscreenUI(state.queue[state.currentIndex]);
        }
    }
}

function updateFullscreenUI(track) {
    if (!track) return;
    fsTitle.textContent = track.name;
    const year = track.release_date ? track.release_date.slice(0, 4) : '';
    fsArtist.textContent = year ? `${track.artists} • ${year}` : track.artists;
    fsArt.src = track.album_art || '/static/icon.svg';
    
    // Backdrop
    const backdrop = document.querySelector('.fs-backdrop');
    if (backdrop) backdrop.style.backgroundImage = `url('${track.album_art || '/static/icon.svg'}')`;
    
    // DJ Mode Info for Fullscreen
    const fsDJInfo = $('#fs-dj-info');
    if (state.djMode && fsDJInfo) {
        const isLocal = track.id?.startsWith('local_');
        const feat = isLocal ? track.audio_features : state.audioFeaturesCache[track.id];
        
        if (feat) {
            const camelotClass = feat.camelot ? `camelot-${feat.camelot}` : '';
            fsDJInfo.innerHTML = `
                <div class="dj-badge-container" style="display: flex; justify-content: center; gap: 8px; margin-top: 8px;">
                    <span class="dj-badge bpm-badge">${feat.bpm} BPM</span>
                    <span class="dj-badge camelot-badge ${camelotClass}">${feat.camelot}</span>
                </div>
            `;
            fsDJInfo.classList.remove('hidden');
        } else {
            fsDJInfo.classList.add('hidden');
        }
    } else if (fsDJInfo) {
        fsDJInfo.classList.add('hidden');
    }
    
    updateFSPlayBtn();
}

function updateFSPlayBtn() {
    if (!fsPlayBtn) return;
    fsPlayBtn.textContent = state.isPlaying ? '⏸' : '▶';
}

// FS Controls
if (fsToggleBtn) fsToggleBtn.addEventListener('click', toggleFullScreen);
if (fsCloseBtn) fsCloseBtn.addEventListener('click', toggleFullScreen);
if (fsPlayBtn) fsPlayBtn.addEventListener('click', () => playBtn.click());

// FS Prev/Next - seek ±15s for podcasts, otherwise prev/next track
const fsHeartBtn = $('#fs-heart-btn');
if (fsPrevBtn) {
    fsPrevBtn.addEventListener('click', () => {
        const currentTrack = state.queue[state.currentIndex];
        const player = getActivePlayer();
        if (currentTrack && currentTrack.source === 'podcast') {
            player.currentTime = Math.max(0, player.currentTime - 15);
        } else {
            prevBtn.click();
        }
    });
}
if (fsNextBtn) {
    fsNextBtn.addEventListener('click', () => {
        const currentTrack = state.queue[state.currentIndex];
        const player = getActivePlayer();
        if (currentTrack && currentTrack.source === 'podcast') {
            player.currentTime = Math.min(player.duration, player.currentTime + 15);
        } else {
            nextBtn.click();
        }
    });
}

// FS Heart button - add current track to playlist
if (fsHeartBtn) {
    fsHeartBtn.addEventListener('click', () => {
        const currentTrack = state.queue[state.currentIndex];
        if (currentTrack && window.openAddToPlaylistModal) {
            window.openAddToPlaylistModal(currentTrack);
        } else {
            showToast('No track playing');
        }
    });
}

// More Menu Controls
const moreControlsBtn = $('#more-controls-btn');
const playerMoreMenu = $('#player-more-menu');

if (moreControlsBtn && playerMoreMenu) {
    moreControlsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playerMoreMenu.classList.toggle('hidden');
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (!playerMoreMenu.classList.contains('hidden') && 
            !playerMoreMenu.contains(e.target) && 
            e.target !== moreControlsBtn) {
            playerMoreMenu.classList.add('hidden');
        }
    });
}
if (fsProgressBar) {
    fsProgressBar.addEventListener('input', (e) => {
        const player = getActivePlayer();
        if (player.duration) {
            player.currentTime = (e.target.value / 100) * player.duration;
        }
    });
}

// Navigation Links
playerTitle.classList.add('clickable-link');
playerArtist.classList.add('clickable-link');

playerTitle.addEventListener('click', () => {
   if (state.currentIndex >= 0 && !fullscreenPlayer.classList.contains('hidden')) toggleFullScreen(); // Close FS if open? Or works anyway.
   if (state.currentIndex >= 0) {
       const track = state.queue[state.currentIndex];
       performSearch(track.name + " " + track.artists);
   }
});

playerArtist.addEventListener('click', () => {
   if (state.currentIndex >= 0) {
       performSearch(state.queue[state.currentIndex].artists);
   }
});

// ========== TOAST NOTIFICATIONS ==========
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    
    // Remove after animation
    setTimeout(() => toast.remove(), 3000);
}

// ========== VOLUME CONTROL ==========
// Shared volume update function
function updateVolume(vol) {
    if (vol < 0) vol = 0;
    if (vol > 1) vol = 1;
    
    state.volume = vol;
    audioPlayer.volume = vol;
    audioPlayer2.volume = vol; // Apply to both players
    state.muted = vol === 0;
    
    // Persist volume to localStorage
    localStorage.setItem('freedify_volume', vol.toString());
    
    // Update main slider UI if needed
    const sliderVal = Math.round(vol * 100);
    if (volumeSlider.value != sliderVal) volumeSlider.value = sliderVal;
    
    // Update PiP slider if exists
    if (pipWindow) {
         const waVol = pipWindow.document.getElementById('wa-vol');
         if (waVol && waVol.value != sliderVal) waVol.value = sliderVal;
    }
    
    updateMuteIcon();
}

volumeSlider.addEventListener('input', (e) => {
    updateVolume(e.target.value / 100);
});

muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    if (state.muted) {
        audioPlayer.volume = 0;
        audioPlayer2.volume = 0;
        volumeSlider.value = 0;
    } else {
        audioPlayer.volume = state.volume || 1;
        audioPlayer2.volume = state.volume || 1;
        volumeSlider.value = (state.volume || 1) * 100;
    }
    updateMuteIcon();
});

function updateMuteIcon() {
    if (state.muted || audioPlayer.volume === 0) {
        muteBtn.textContent = '🔇';
    } else if (audioPlayer.volume < 0.5) {
        muteBtn.textContent = '🔉';
    } else {
        muteBtn.textContent = '🔊';
    }
}

// ========== REPEAT MODE ==========
repeatBtn.addEventListener('click', () => {
    // Cycle: none -> all -> one -> none
    if (state.repeatMode === 'none') {
        state.repeatMode = 'all';
        repeatBtn.classList.add('repeat-active');
        repeatBtn.title = 'Repeat: All';
        showToast('Repeat: All');
    } else if (state.repeatMode === 'all') {
        state.repeatMode = 'one';
        repeatBtn.classList.add('repeat-one');
        repeatBtn.title = 'Repeat: One';
        showToast('Repeat: One');
    } else {
        state.repeatMode = 'none';
        repeatBtn.classList.remove('repeat-active', 'repeat-one');
        repeatBtn.title = 'Repeat: Off';
        showToast('Repeat: Off');
    }
});

// ========== KEYBOARD SHORTCUTS ==========
shortcutsClose.addEventListener('click', () => {
    shortcutsHelp.classList.add('hidden');
});

document.addEventListener('keydown', (e) => {
    // Skip if typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    switch (e.key) {
        case ' ':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowRight':
            if (e.shiftKey) {
                const player = getActivePlayer();
                player.currentTime = Math.min(player.duration, player.currentTime + 10);
            } else {
                playNext();
            }
            break;
        case 'ArrowLeft':
            if (e.shiftKey) {
                const player = getActivePlayer();
                player.currentTime = Math.max(0, player.currentTime - 10);
            } else {
                playPrevious();
            }
            break;
        case 'ArrowUp':
            e.preventDefault();
            updateVolume(Math.min(1, state.volume + 0.1));
            showToast(`Volume: ${Math.round(state.volume * 100)}%`);
            break;
        case 'ArrowDown':
            e.preventDefault();
            updateVolume(Math.max(0, state.volume - 0.1));
            showToast(`Volume: ${Math.round(state.volume * 100)}%`);
            break;
        case 'm':
        case 'M':
            muteBtn.click();
            break;
        case 's':
        case 'S':
            shuffleQueueBtn.click();
            showToast('Queue Shuffled');
            break;
        case 'r':
        case 'R':
            repeatBtn.click();
            break;
        case 'f':
        case 'F':
            toggleFullScreen();
            break;
        case 'q':
        case 'Q':
            queueSection.classList.toggle('hidden');
            break;
        case '?':
            shortcutsHelp.classList.toggle('hidden');
            break;
    }
});

// ========== QUEUE DRAG & DROP ==========
let draggedItem = null;
let draggedIndex = -1;

function initQueueDragDrop() {
    const items = queueContainer.querySelectorAll('.queue-item');
    
    items.forEach((item, index) => {
        item.setAttribute('draggable', 'true');
        
        item.addEventListener('dragstart', (e) => {
            draggedItem = item;
            draggedIndex = index;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            draggedItem = null;
            draggedIndex = -1;
            items.forEach(i => i.classList.remove('drag-over'));
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (item !== draggedItem) {
                item.classList.add('drag-over');
            }
        });
        
        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            if (item === draggedItem) return;
            
            const targetIndex = index;
            
            // Reorder queue
            const [movedTrack] = state.queue.splice(draggedIndex, 1);
            state.queue.splice(targetIndex, 0, movedTrack);
            
            // Update current index if needed
            if (state.currentIndex === draggedIndex) {
                state.currentIndex = targetIndex;
            } else if (draggedIndex < state.currentIndex && targetIndex >= state.currentIndex) {
                state.currentIndex--;
            } else if (draggedIndex > state.currentIndex && targetIndex <= state.currentIndex) {
                state.currentIndex++;
            }
            
            updateQueueUI();
            showToast('Queue reordered');
        });
        
    });
}

// Patch updateQueueUI to init drag-drop
const originalUpdateQueueUI = updateQueueUI;
window.updateQueueUIPatched = function() {
    originalUpdateQueueUI();
    initQueueDragDrop();
};

// Override the function (need to call it after original)
const _originalUpdateQueueUI = updateQueueUI;
updateQueueUI = function() {
    _originalUpdateQueueUI.apply(this, arguments);
    setTimeout(initQueueDragDrop, 0);
};

// ========== EQUALIZER (Web Audio API) ==========
const eqPanel = $('#eq-panel');
const eqToggleBtn = $('#eq-toggle-btn');
const eqCloseBtn = $('#eq-close-btn');
const eqPresets = $$('.eq-preset');
const bassBoostSlider = $('#bass-boost');
const bassBoostVal = $('#bass-boost-val');
const volumeBoostSlider = $('#volume-boost');
const volumeBoostVal = $('#volume-boost-val');

// Audio context and nodes (created lazily)
let audioContext = null;
let sourceNode = null;
let sourceNode2 = null;
let gainNode1 = null; // Gain for player 1 (for crossfade)
let gainNode2 = null; // Gain for player 2 (for crossfade)
let eqFilters = [];
let bassBoostFilter = null;
let volumeBoostGain = null;
let eqConnected = false;

// EQ frequency bands
const EQ_BANDS = [
    { id: 'eq-60', freq: 60, type: 'lowshelf' },
    { id: 'eq-230', freq: 230, type: 'peaking' },
    { id: 'eq-910', freq: 910, type: 'peaking' },
    { id: 'eq-3600', freq: 3600, type: 'peaking' },
    { id: 'eq-7500', freq: 7500, type: 'highshelf' }
];

// Presets (dB values for each band)
const EQ_PRESETS = {
    flat: [0, 0, 0, 0, 0],
    bass: [6, 4, 0, 0, 0],
    treble: [0, 0, 0, 3, 6],
    vocal: [-2, 0, 4, 2, -1]
};

function initEqualizer() {
    if (audioContext) return; // Already initialized
    
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // Auto-resume AudioContext when Android suspends it in background
        audioContext.onstatechange = () => {
            if (audioContext.state === 'suspended' && state.isPlaying) {
                console.log('AudioContext suspended while playing — auto-resuming');
                audioContext.resume();
            }
        };
        
        // Create source nodes for both audio players
        sourceNode = audioContext.createMediaElementSource(audioPlayer);
        sourceNode2 = audioContext.createMediaElementSource(audioPlayer2);
        
        // Create gain nodes for crossfade control
        gainNode1 = audioContext.createGain();
        gainNode2 = audioContext.createGain();
        gainNode1.gain.value = 1; // Player 1 starts active
        gainNode2.gain.value = 0; // Player 2 starts silent
        
        // Create EQ filter nodes
        eqFilters = EQ_BANDS.map(band => {
            const filter = audioContext.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.freq;
            filter.gain.value = 0;
            if (band.type === 'peaking') filter.Q.value = 1;
            return filter;
        });
        
        // Create bass boost filter (low shelf)
        bassBoostFilter = audioContext.createBiquadFilter();
        bassBoostFilter.type = 'lowshelf';
        bassBoostFilter.frequency.value = 100;
        bassBoostFilter.gain.value = 0;
        
        // Create volume boost gain node
        volumeBoostGain = audioContext.createGain();
        volumeBoostGain.gain.value = 1;
        
        // Connect chains:
        // Player 1: source -> gain1 -> first EQ filter
        // Player 2: source2 -> gain2 -> first EQ filter
        // Then: EQ chain -> bass boost -> volume boost -> destination
        sourceNode.connect(gainNode1);
        sourceNode2.connect(gainNode2);
        
        // Both gains merge into first EQ filter
        const firstFilter = eqFilters[0];
        gainNode1.connect(firstFilter);
        gainNode2.connect(firstFilter);
        
        // Connect EQ filter chain
        let lastNode = firstFilter;
        for (let i = 1; i < eqFilters.length; i++) {
            lastNode.connect(eqFilters[i]);
            lastNode = eqFilters[i];
        }
        lastNode.connect(bassBoostFilter);
        bassBoostFilter.connect(volumeBoostGain);
        volumeBoostGain.connect(audioContext.destination);
        
        eqConnected = true;
        
        // Load saved settings
        loadEqSettings();
        
        console.log('Equalizer initialized with crossfade support');
    } catch (e) {
        console.error('Failed to initialize equalizer:', e);
    }
}

function loadEqSettings() {
    const saved = localStorage.getItem('freedify_eq');
    if (saved) {
        try {
            const settings = JSON.parse(saved);
            EQ_BANDS.forEach((band, i) => {
                const slider = $(`#${band.id}`);
                if (slider && settings.bands[i] !== undefined) {
                    slider.value = settings.bands[i];
                    if (eqFilters[i]) eqFilters[i].gain.value = settings.bands[i];
                }
            });
            if (settings.bass !== undefined) {
                bassBoostSlider.value = settings.bass;
                if (bassBoostFilter) bassBoostFilter.gain.value = settings.bass;
                bassBoostVal.textContent = `${settings.bass}dB`;
            }
            if (settings.volume !== undefined) {
                volumeBoostSlider.value = settings.volume;
                if (volumeBoostGain) volumeBoostGain.gain.value = Math.pow(10, settings.volume / 20);
                volumeBoostVal.textContent = `${settings.volume}dB`;
            }
        } catch (e) { console.error('Error loading EQ settings:', e); }
    }
}

function saveEqSettings() {
    const settings = {
        bands: EQ_BANDS.map(band => parseFloat($(`#${band.id}`).value)),
        bass: parseFloat(bassBoostSlider.value),
        volume: parseFloat(volumeBoostSlider.value)
    };
    localStorage.setItem('freedify_eq', JSON.stringify(settings));
}

function applyPreset(preset) {
    const values = EQ_PRESETS[preset];
    if (!values) return;
    
    EQ_BANDS.forEach((band, i) => {
        const slider = $(`#${band.id}`);
        slider.value = values[i];
        if (eqFilters[i]) eqFilters[i].gain.value = values[i];
    });
    
    eqPresets.forEach(btn => btn.classList.remove('active'));
    document.querySelector(`[data-preset="${preset}"]`)?.classList.add('active');
    
    saveEqSettings();
}

// Toggle EQ panel
eqToggleBtn?.addEventListener('click', () => {
    if (!audioContext) initEqualizer();
    eqPanel.classList.toggle('hidden');
    eqToggleBtn.classList.toggle('active');
});

eqCloseBtn?.addEventListener('click', () => {
    eqPanel.classList.add('hidden');
    eqToggleBtn.classList.remove('active');
});

// Preset buttons
eqPresets.forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

// EQ band sliders
EQ_BANDS.forEach((band, i) => {
    const slider = $(`#${band.id}`);
    slider?.addEventListener('input', () => {
        if (eqFilters[i]) eqFilters[i].gain.value = parseFloat(slider.value);
        saveEqSettings();
        // Clear preset selection when manually adjusting
        eqPresets.forEach(btn => btn.classList.remove('active'));
    });
});

// Bass boost slider
bassBoostSlider?.addEventListener('input', () => {
    const val = parseFloat(bassBoostSlider.value);
    if (bassBoostFilter) bassBoostFilter.gain.value = val;
    bassBoostVal.textContent = `${val}dB`;
    saveEqSettings();
});

// Volume boost slider
volumeBoostSlider?.addEventListener('input', () => {
    const val = parseFloat(volumeBoostSlider.value);
    // Convert dB to gain multiplier: gain = 10^(dB/20)
    if (volumeBoostGain) volumeBoostGain.gain.value = Math.pow(10, val / 20);
    volumeBoostVal.textContent = `${val}dB`;
    saveEqSettings();
});

// Initialize EQ when audio starts playing (to resume AudioContext)
function handleEQResume() {
    if (!audioContext) {
        initEqualizer();
    } else if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}
audioPlayer.addEventListener('play', handleEQResume);
audioPlayer2.addEventListener('play', handleEQResume);

// ========== THEME PICKER ==========
const themeBtn = $('#theme-btn');
const themePicker = $('#theme-picker');
const themeOptions = $$('.theme-option');

// Load saved theme on startup
(function loadSavedTheme() {
    const savedTheme = localStorage.getItem('freedify_theme') || '';
    if (savedTheme) {
        document.body.classList.add(savedTheme);
    }
    // Mark active option
    themeOptions.forEach(opt => {
        if (opt.dataset.theme === savedTheme) {
            opt.classList.add('active');
        }
    });
    
    // Sync meta theme-color on load
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor && savedTheme) {
        setTimeout(() => {
            const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
            if (accentColor) metaThemeColor.content = accentColor;
        }, 50);
    }
})();

// Toggle theme picker
themeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    themePicker.classList.toggle('hidden');
});

// Theme selection
themeOptions.forEach(opt => {
    opt.addEventListener('click', () => {
        const newTheme = opt.dataset.theme;
        
        // Remove all theme classes
        document.body.classList.remove('theme-purple', 'theme-blue', 'theme-green', 'theme-pink', 'theme-orange', 'theme-dracula', 'theme-catppuccin', 'theme-nightowl', 'theme-nuclear');
        
        // Add new theme
        if (newTheme) {
            document.body.classList.add(newTheme);
        }
        
        // Save to localStorage
        localStorage.setItem('freedify_theme', newTheme);
        
        // Update active state
        themeOptions.forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        
        // Close picker
        themePicker.classList.add('hidden');
        
        showToast(`Theme changed to ${opt.textContent}`);
        
        // Update meta theme-color for mobile browser UI
        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) {
            // Get computed color for current theme
            // Wait a tick for class change to apply
            setTimeout(() => {
                const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
                if (accentColor) metaThemeColor.content = accentColor;
            }, 50);
        }
    });
});

// Close theme picker when clicking outside
document.addEventListener('click', (e) => {
    if (!themePicker.contains(e.target) && e.target !== themeBtn) {
        themePicker.classList.add('hidden');
    }
});

// ========== MEDIA SESSION API (Lock Screen Controls) ==========

function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    
    const artworkSrc = track.album_art || '/static/icon.svg';
    navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name || 'Unknown Track',
        artist: track.artists || 'Unknown Artist',
        album: track.album || '',
        artwork: [
            { src: artworkSrc, sizes: '96x96', type: 'image/png' },
            { src: artworkSrc, sizes: '128x128', type: 'image/png' },
            { src: artworkSrc, sizes: '192x192', type: 'image/png' },
            { src: artworkSrc, sizes: '256x256', type: 'image/png' },
            { src: artworkSrc, sizes: '384x384', type: 'image/png' },
            { src: artworkSrc, sizes: '512x512', type: 'image/png' }
        ]
    });
    navigator.mediaSession.playbackState = 'playing';
    console.log('MediaSession metadata set for:', track.name);
}

// Register action handlers at page load — they persist across playbacks (per web.dev spec)
if ('mediaSession' in navigator) {
    const actionHandlers = [
        ['play', async () => {
            console.log('MediaSession: play action triggered');
            if (audioContext?.state === 'suspended') {
                await audioContext.resume();
            }
            await getActivePlayer().play().catch(e => console.warn('MediaSession play failed:', e));
        }],
        ['pause', () => {
            console.log('MediaSession: pause action triggered');
            getActivePlayer().pause();
        }],
        ['previoustrack', () => {
            console.log('MediaSession: previoustrack action triggered');
            playPrevious();
        }],
        ['nexttrack', () => {
            console.log('MediaSession: nexttrack action triggered');
            playNext();
        }],
        ['seekbackward', (details) => {
            const player = getActivePlayer();
            player.currentTime = Math.max(player.currentTime - (details.seekOffset || 10), 0);
        }],
        ['seekforward', (details) => {
            const player = getActivePlayer();
            player.currentTime = Math.min(player.currentTime + (details.seekOffset || 10), player.duration);
        }],
        ['seekto', (details) => {
            const player = getActivePlayer();
            if (details.fastSeek && 'fastSeek' in player) {
                player.fastSeek(details.seekTime);
            } else {
                player.currentTime = details.seekTime;
            }
        }],
        ['stop', () => {
            getActivePlayer().pause();
            getActivePlayer().currentTime = 0;
            state.isPlaying = false;
            updatePlayButton();
            navigator.mediaSession.playbackState = 'none';
        }]
    ];

    for (const [action, handler] of actionHandlers) {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
            console.log(`MediaSession: registered '${action}' handler`);
        } catch (error) {
            console.log(`MediaSession: '${action}' not supported`);
        }
    }
}

// Update position state for lock screen on BOTH players
function updateMediaSessionPosition() {
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
        try {
            const player = getActivePlayer();
            if (player.duration && !isNaN(player.duration) && player.duration > 0) {
                navigator.mediaSession.setPositionState({
                    duration: player.duration,
                    playbackRate: player.playbackRate,
                    position: Math.min(player.currentTime, player.duration)
                });
            }
        } catch (e) { /* Ignore errors */ }
    }
}
audioPlayer.addEventListener('timeupdate', updateMediaSessionPosition);
audioPlayer2.addEventListener('timeupdate', updateMediaSessionPosition);

// ========== ANDROID BACKGROUND PLAYBACK RESILIENCE ==========

// Resume AudioContext and clear stale guards when page becomes visible
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        // Resume main AudioContext if suspended while playing
        if (audioContext?.state === 'suspended' && state.isPlaying) {
            console.log('Visibility restored — resuming AudioContext');
            audioContext.resume();
        }
        // Clear stale crossfade guard that may have been frozen
        if (crossfadeTimeout) {
            clearTimeout(crossfadeTimeout);
            crossfadeTimeout = null;
        }
        // If we should be playing but audio is paused, try to resume
        const player = getActivePlayer();
        if (state.isPlaying && player.paused && player.readyState >= 2) {
            console.log('Visibility restored — resuming paused playback');
            player.play().catch(() => {});
        }
    }
});

// Recover from network drops in background
window.addEventListener('online', () => {
    const player = getActivePlayer();
    if (state.isPlaying && (player.paused || player.readyState < 3)) {
        console.log('Network restored — attempting stream recovery');
        const pos = player.currentTime;
        player.currentTime = pos; // Force reconnect by seeking to current position
        player.play().catch(() => {});
    }
});

// ========== GOOGLE DRIVE SYNC ==========
// Client ID: fetched from server env var, or from localStorage, or prompted
let GOOGLE_CLIENT_ID = localStorage.getItem('freedify_google_client_id') || '';
// Expanded scope: appdata for favorites sync + drive.file for saving audio files
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
const SYNC_FILENAME = 'freedify_playlists.json';
const FREEDIFY_FOLDER_NAME = 'Freedify';

let googleAccessToken = null;

// Fetch server-side config (Google Client ID from env vars)
(async function loadServerConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            const config = await res.json();
            if (config.google_client_id) {
                GOOGLE_CLIENT_ID = config.google_client_id;
                console.log('Google Client ID loaded from server config');
            }
        }
    } catch (e) {
        console.log('Could not load server config:', e.message);
    }
})();
const syncBtn = $('#sync-btn');

// Initialize Google API
// Initialize Google API
window.initGoogleApi = function() {
    return new Promise((resolve) => {
        if (typeof gapi === 'undefined') {
            console.log('Google API not loaded yet');
            resolve(false);
            return;
        }
        gapi.load('client', async () => {
            try {
                await gapi.client.init({
                    discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
                });
                console.log("Google Drive API initialized");
                resolve(true);
            } catch (e) {
                console.error('Failed to init Google API:', e);
                resolve(false);
            }
        });
    });
};

// If gapi is already loaded (race condition), init immediately
if (typeof gapi !== 'undefined') {
    window.initGoogleApi();
}

// Google Sign-In
async function signInWithGoogle() {
    if (!GOOGLE_CLIENT_ID) {
        const clientId = prompt(
            'Enter your Google OAuth Client ID:\n\n' +
            'To get one:\n' +
            '1. Go to console.cloud.google.com\n' +
            '2. Create a project\n' +
            '3. Enable Drive API\n' +
            '4. Create OAuth credentials (Web application)\n' +
            '5. Add your domain to authorized origins'
        );
        if (clientId) {
            localStorage.setItem('freedify_google_client_id', clientId);
            location.reload();
        }
        return null;
    }
    
    return new Promise((resolve) => {
        const client = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: GOOGLE_SCOPES,
            callback: (response) => {
                if (response.access_token) {
                    googleAccessToken = response.access_token;
                    gapi.client.setToken({ access_token: googleAccessToken });
                    syncBtn.classList.add('synced');
                    showToast('Signed in to Google Drive');
                    resolve(response.access_token);
                } else {
                    resolve(null);
                }
            },
            error_callback: (error) => {
                console.error('Google sign-in error:', error);
                showToast('Sign-in failed');
                resolve(null);
            }
        });
        client.requestAccessToken();
    });
}

// Find sync file in Drive
async function findSyncFile() {
    try {
        const response = await gapi.client.drive.files.list({
            spaces: 'appDataFolder',
            q: `name='${SYNC_FILENAME}'`,
            fields: 'files(id, name, modifiedTime)'
        });
        return response.result.files?.[0] || null;
    } catch (e) {
        console.error('Error finding sync file:', e);
        return null;
    }
}

// Find or create "Freedify" folder in Drive root
async function findOrCreateFreedifyFolder() {
    try {
        // Search for existing folder
        const response = await gapi.client.drive.files.list({
            q: `name='${FREEDIFY_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)'
        });
        
        if (response.result.files && response.result.files.length > 0) {
            return response.result.files[0].id;
        }
        
        // Create folder if not found
        const createResponse = await gapi.client.drive.files.create({
            resource: {
                name: FREEDIFY_FOLDER_NAME,
                mimeType: 'application/vnd.google-apps.folder'
            },
            fields: 'id'
        });
        
        return createResponse.result.id;
    } catch (e) {
        console.error('Error finding/creating folder:', e);
        return null;
    }
}

// Upload to Drive with Granular Support
// syncType: 'all', 'playlists', 'queue'
async function uploadToDrive(syncType = 'all') {
    if (!googleAccessToken) {
        await signInWithGoogle();
        if (!googleAccessToken) return; // User cancelled auth
    }
    
    const loadingText = syncType === 'all' ? 'Syncing all to Drive...' : 
                        syncType === 'playlists' ? 'Syncing playlists...' : 'Syncing queue...';
    showLoading(loadingText);
    
    try {
        // 1. Fetch EXISTING file first to preserve data we aren't updating
        const existingFile = await findSyncFile();
        let currentRemoteData = {};
        
        if (existingFile) {
            try {
                const response = await fetch(
                    `https://www.googleapis.com/drive/v3/files/${existingFile.id}?alt=media`,
                    { headers: { 'Authorization': `Bearer ${googleAccessToken}` } }
                );
                if (response.ok) {
                    const json = await response.json();
                    // Handle legacy array format
                    if (Array.isArray(json)) {
                         currentRemoteData = { playlists: json, queue: [] };
                    } else {
                         currentRemoteData = json;
                    }
                }
            } catch (err) {
                console.warn('Failed to read existing sync data, starting fresh', err);
            }
        }

        // 2. Prepare NEW data by merging state into remote data
        const syncData = {
            playlists: currentRemoteData.playlists || [],
            library: currentRemoteData.library || [],
            history: currentRemoteData.history || [],
            queue: currentRemoteData.queue || [],
            currentIndex: currentRemoteData.currentIndex || 0,
            volume: currentRemoteData.volume || 1,
            syncedAt: new Date().toISOString()
        };

        if (syncType === 'all' || syncType === 'playlists') {
            syncData.playlists = state.playlists;
            syncData.library = state.library;
            syncData.history = state.history;
            syncData.podcastFavorites = state.podcastFavorites;
            syncData.audiobookFavorites = state.audiobookFavorites;
            syncData.podcastPlayedEpisodes = state.podcastPlayedEpisodes;
            syncData.podcastResumePositions = state.podcastResumePositions;
            syncData.podcastHistory = state.podcastHistory;
            syncData.audiobookHistory = state.audiobookHistory;
            syncData.podcastTags = state.podcastTags;
        }
        
        if (syncType === 'all' || syncType === 'queue') {
            syncData.queue = state.queue;
            syncData.currentIndex = state.currentIndex;
            syncData.volume = state.volume;
        }

        // 3. Upload
        const fileContent = JSON.stringify(syncData, null, 2);
        
        const metadata = {
            name: SYNC_FILENAME,
            mimeType: 'application/json'
        };
        
        if (!existingFile) {
            metadata.parents = ['appDataFolder'];
        }
        
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', new Blob([fileContent], { type: 'application/json' }));
        
        const url = existingFile 
            ? `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=multipart`
            : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
        
        const response = await fetch(url, {
            method: existingFile ? 'PATCH' : 'POST',
            headers: { 'Authorization': `Bearer ${googleAccessToken}` },
            body: form
        });
        
        if (response.ok) {
            hideLoading();
            // Close modal if open
            $('#drive-sync-modal').classList.add('hidden');
            
            let msg = 'Sync Complete!';
            if (syncType === 'playlists') msg = `Synced ${state.playlists.length} playlists to Drive`;
            if (syncType === 'queue') msg = `Synced queue (${state.queue.length} tracks)`;
            if (syncType === 'all') msg = `Synced Match & Queue to Drive`;
            
            showToast(msg);
            localStorage.setItem('freedify_last_sync', new Date().toISOString());
        } else {
            throw new Error('Upload failed');
        }
    } catch (e) {
        console.error('Upload error:', e);
        hideLoading();
        showError('Failed to sync to Google Drive');
    }
}

// Download from Drive with Granular Support
async function downloadFromDrive(syncType = 'all') {
    if (!googleAccessToken) {
        await signInWithGoogle();
        if (!googleAccessToken) return;
    }
    
    showLoading('Loading from Google Drive...');
    
    try {
        const file = await findSyncFile();
        
        if (!file) {
            hideLoading();
            showToast('No saved data found in Drive');
            return;
        }
        
        const response = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
            { headers: { 'Authorization': `Bearer ${googleAccessToken}` } }
        );
        
        if (response.ok) {
            const syncData = await response.json();
            
            // Normalize data (handle legacy)
            const remotePlaylists = Array.isArray(syncData) ? syncData : (syncData.playlists || []);
            const remoteLibrary = Array.isArray(syncData) ? [] : (syncData.library || []);
            const remoteHistory = Array.isArray(syncData) ? [] : (syncData.history || []);
            const remoteQueue = Array.isArray(syncData) ? [] : (syncData.queue || []);
            const remoteIndex = Array.isArray(syncData) ? 0 : (syncData.currentIndex || 0);

            let restoredCount = 0;
            
            // Apply updates
            if (syncType === 'all' || syncType === 'playlists') {
                state.playlists = remotePlaylists;
                savePlaylists();
                
                // Restore library
                if (remoteLibrary.length > 0) {
                    state.library = remoteLibrary;
                    saveLibrary();
                }
                
                // Restore history
                if (remoteHistory.length > 0) {
                    state.history = remoteHistory;
                    saveHistory();
                }
                
                // Restore podcast data
                if (syncData.podcastFavorites) {
                    state.podcastFavorites = syncData.podcastFavorites;
                    savePodcastFavorites();
                }
                
                if (syncData.audiobookFavorites) {
                    state.audiobookFavorites = syncData.audiobookFavorites;
                    saveAudiobookFavorites();
                }
                
                if (syncData.podcastPlayedEpisodes) {
                    state.podcastPlayedEpisodes = syncData.podcastPlayedEpisodes;
                    savePodcastPlayed();
                }
                if (syncData.podcastResumePositions) {
                    state.podcastResumePositions = syncData.podcastResumePositions;
                    savePodcastResumePositions();
                }
                if (syncData.podcastHistory) {
                    state.podcastHistory = syncData.podcastHistory;
                    savePodcastHistory();
                }
                if (syncData.audiobookHistory) {
                    state.audiobookHistory = syncData.audiobookHistory;
                    saveAudiobookHistory();
                }
                if (syncData.podcastTags) {
                    state.podcastTags = syncData.podcastTags;
                    savePodcastTags();
                }
                
                restoredCount = remotePlaylists.length;
                // If favorites view is active, refresh it
                if (state.searchType === 'favorites') renderPlaylistsView();
            }
            
            if (syncType === 'all' || syncType === 'queue') {
                if (remoteQueue.length > 0) {
                   state.queue = remoteQueue;
                   state.currentIndex = remoteIndex;
                   // Use remote volume only if 'all' to avoid startling volume jumps on just queue sync? 
                   // Let's stick to syncing volume on queue sync.
                   if (syncData.volume) {
                       state.volume = syncData.volume;
                       if (audioPlayer) audioPlayer.volume = state.volume;
                       if (audioPlayer2) audioPlayer2.volume = state.volume;
                       if (volumeSlider) volumeSlider.value = Math.round(state.volume * 100);
                   }
                   updateQueueUI();
                   updatePlayerUI();
                }
            }
            
            hideLoading();
            // Close modal
            $('#drive-sync-modal').classList.add('hidden');
            
            if (syncType === 'playlists') showToast(`Loaded ${restoredCount} playlists`);
            else if (syncType === 'queue') showToast(`Loaded queue (${remoteQueue.length} tracks)`);
            else showToast(`Loaded Library & Session`);

        } else {
            throw new Error('Download failed');
        }
    } catch (e) {
        console.error('Download error:', e);
        hideLoading();
        showError('Failed to load from Google Drive');
    }
}

// --- Drive Sync Modal UI & Events ---

function updateDriveModalUI() {
    const authSection = $('#drive-auth-section');
    const optionsSection = $('#drive-options-section');
    const userEmailSpan = $('#drive-user-email');
    
    // Check if we have a valid access token (GIS flow stores it in googleAccessToken)
    if (googleAccessToken) {
        authSection.classList.add('hidden');
        optionsSection.classList.remove('hidden');
        if (userEmailSpan) userEmailSpan.textContent = 'Connected to Google Drive';
    } else {
        authSection.classList.remove('hidden');
        optionsSection.classList.add('hidden');
    }
}

async function showDriveModal() {
    const modal = $('#drive-sync-modal');
    modal.classList.remove('hidden');
    
    // Ensure API is ready
    if (typeof gapi !== 'undefined' && (!gapi.auth2 || !gapi.client.drive)) {
        $('#drive-loading').classList.remove('hidden');
        await initGoogleApi();
        $('#drive-loading').classList.add('hidden');
    }
    updateDriveModalUI();
}

// Open Modal
syncBtn?.addEventListener('click', () => {
    showDriveModal();
});

// Close Modal
$('#drive-modal-close')?.addEventListener('click', () => $('#drive-sync-modal').classList.add('hidden'));
$('#drive-modal-close-top')?.addEventListener('click', () => $('#drive-sync-modal').classList.add('hidden'));

// Auth Buttons
$('#drive-signin-btn')?.addEventListener('click', async () => {
    await signInWithGoogle();
    updateDriveModalUI();
});

$('#drive-signout-btn')?.addEventListener('click', () => {
    googleAccessToken = null;
    gapi.client.setToken(null);
    syncBtn?.classList.remove('synced');
    updateDriveModalUI();
    showToast('Signed out from Google Drive');
});

// Granular Action Bindings
$('#drive-up-all')?.addEventListener('click', () => uploadToDrive('all'));
$('#drive-up-playlists')?.addEventListener('click', () => uploadToDrive('playlists'));
$('#drive-up-queue')?.addEventListener('click', () => uploadToDrive('queue'));

$('#drive-down-all')?.addEventListener('click', () => downloadFromDrive('all'));
$('#drive-down-playlists')?.addEventListener('click', () => downloadFromDrive('playlists'));
$('#drive-down-queue')?.addEventListener('click', () => downloadFromDrive('queue'));

// ========== PODCAST EPISODE DETAILS MODAL ==========
const podcastModal = $('#podcast-modal');
const podcastModalClose = $('#podcast-modal-close');
const podcastModalArt = $('#podcast-modal-art');
const podcastModalTitle = $('#podcast-modal-title');
const podcastModalDate = $('#podcast-modal-date');
const podcastModalDuration = $('#podcast-modal-duration');
const podcastModalDescription = $('#podcast-modal-description');
const podcastModalPlay = $('#podcast-modal-play');

let currentPodcastEpisode = null;

function showPodcastModal(trackJson) {
    if (!trackJson) return;
    
    try {
        const track = typeof trackJson === 'string' 
            ? JSON.parse(decodeURIComponent(trackJson)) 
            : trackJson;
            
        if (track.source !== 'podcast') return;
        
        currentPodcastEpisode = track;
        
        podcastModalArt.src = track.album_art || '/static/icon.svg';
        podcastModalTitle.textContent = track.name;
        podcastModalDate.textContent = track.datePublished || '';
        podcastModalDuration.textContent = `Duration: ${track.duration}`;
        
        // Strip HTML tags from description and decode entities
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = track.description || 'No description available.';
        podcastModalDescription.textContent = tempDiv.textContent || tempDiv.innerText;
        
        podcastModal.classList.remove('hidden');
    } catch (e) {
        console.error('Error opening podcast modal:', e);
    }
}
window.showPodcastModal = showPodcastModal;

function hidePodcastModal() {
    podcastModal.classList.add('hidden');
    currentPodcastEpisode = null;
}

// Close modal
podcastModalClose?.addEventListener('click', hidePodcastModal);

// Close on backdrop click
podcastModal?.addEventListener('click', (e) => {
    if (e.target === podcastModal) hidePodcastModal();
});

// Play button
podcastModalPlay?.addEventListener('click', () => {
    if (currentPodcastEpisode) {
        playTrack(currentPodcastEpisode);
        hidePodcastModal();
    }
});

// Close on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !podcastModal.classList.contains('hidden')) {
        hidePodcastModal();
    }
});
// ========== HiFi MODE ==========
const hifiBtn = $('#hifi-btn');

// Initialize HiFi button state - reflects actual playing quality, not just preference
// Initialize HiFi button state - reflects user preference and source limits
function updateHifiButtonUI() {
    if (hifiBtn) {
        const currentTrack = state.queue[state.currentIndex];
        const source = currentTrack?.source || '';
        
        // Determine constraint based on source
        const isLossySource = source === 'ytmusic' || source === 'youtube' || source === 'podcast' || source === 'import';
        
        if (isLossySource) {
            // Force Lossy display if source is known bad
            hifiBtn.classList.remove('hi-res');
            hifiBtn.classList.add('active', 'lossy');
            hifiBtn.title = "Playing: Compressed Audio (MP3/AAC)";
            hifiBtn.textContent = "MP3";
        } else {
            // For all other sources (HiFi, Hi-Res, Unknown), reflect the MODE setting
            hifiBtn.classList.add('active');
            hifiBtn.classList.remove('lossy');
            
            // Toggle Hi-Res vs HiFi based on state
            // If state.hiResMode is true -> Add class 'hi-res' -> CSS makes it Cyan/Pulse
            // If state.hiResMode is false -> Remove class 'hi-res' -> CSS makes it Green
            hifiBtn.classList.toggle('hi-res', state.hiResMode);
            
            if (state.hiResMode) {
                const qualityLabel = state.hiResQuality === '5' ? '192kHz/24-bit' : '96kHz/24-bit';
                hifiBtn.title = `Hi-Res Mode ON (${qualityLabel})`;
                hifiBtn.textContent = state.hiResQuality === '5' ? 'Hi-Res+' : 'Hi-Res';
            } else {
                hifiBtn.title = 'HiFi Mode ON (16-bit)';
                hifiBtn.textContent = 'HiFi';
            }
        }
    }
}

// Toggle HiFi mode
if (hifiBtn) {
    hifiBtn.addEventListener('click', () => {
        // Cycle: HiFi (16-bit) → Hi-Res 96/24 → Hi-Res 192/24 → HiFi
        if (!state.hiResMode) {
            // HiFi → Hi-Res 96/24
            state.hiResMode = true;
            state.hiResQuality = '6';
            showToast('💎 Hi-Res Mode ON — 96kHz / 24-bit', 3000);
        } else if (state.hiResQuality === '6') {
            // Hi-Res 96/24 → Hi-Res 192/24
            state.hiResQuality = '5';
            showToast('💎 Hi-Res MAX — 192kHz / 24-bit', 3000);
        } else {
            // Hi-Res 192/24 → HiFi
            state.hiResMode = false;
            state.hiResQuality = '6';
            showToast('🎵 HiFi Mode ON — 16-bit Audio', 3000);
        }
        localStorage.setItem('freedify_hires', state.hiResMode);
        localStorage.setItem('freedify_hires_quality', state.hiResQuality);
        updateHifiButtonUI();
    });
    
    // Initialize UI on load
    updateHifiButtonUI();
}

// ========== DJ MODE ==========
const djModeBtn = $('#dj-mode-btn');
const djSetlistModal = $('#dj-setlist-modal');
const djModalClose = $('#dj-modal-close');
const djStyleSelect = $('#dj-style-select');
const djSetlistLoading = $('#dj-setlist-loading');
const djSetlistResults = $('#dj-setlist-results');
const djOrderedTracks = $('#dj-ordered-tracks');
const djGenerateBtn = $('#dj-generate-btn');
const djApplyBtn = $('#dj-apply-btn');

// Musical Key to Camelot Wheel conversion
function musicalKeyToCamelot(key) {
    if (!key) return null;
    
    // Normalize key: uppercase, handle sharps/flats
    const normalized = key.trim()
        .replace(/major/i, '')
        .replace(/minor/i, 'm')
        .replace(/♯/g, '#')
        .replace(/♭/g, 'b')
        .trim();
    
    // Mapping of musical keys to Camelot notation
    // Minor keys (A column)
    const minorKeys = {
        'Abm': '1A', 'G#m': '1A',
        'Ebm': '2A', 'D#m': '2A',
        'Bbm': '3A', 'A#m': '3A',
        'Fm': '4A',
        'Cm': '5A',
        'Gm': '6A',
        'Dm': '7A',
        'Am': '8A',
        'Em': '9A',
        'Bm': '10A',
        'F#m': '11A', 'Gbm': '11A',
        'Dbm': '12A', 'C#m': '12A'
    };
    
    // Major keys (B column)
    const majorKeys = {
        'B': '1B',
        'Gb': '2B', 'F#': '2B',
        'Db': '3B', 'C#': '3B',
        'Ab': '4B', 'G#': '4B',
        'Eb': '5B', 'D#': '5B',
        'Bb': '6B', 'A#': '6B',
        'F': '7B',
        'C': '8B',
        'G': '9B',
        'D': '10B',
        'A': '11B',
        'E': '12B'
    };
    
    // Check minor first, then major
    if (minorKeys[normalized]) return minorKeys[normalized];
    if (majorKeys[normalized]) return majorKeys[normalized];
    
    // Try case-insensitive match
    for (const [k, v] of Object.entries(minorKeys)) {
        if (k.toLowerCase() === normalized.toLowerCase()) return v;
    }
    for (const [k, v] of Object.entries(majorKeys)) {
        if (k.toLowerCase() === normalized.toLowerCase()) return v;
    }
    
    // If already in Camelot format, return as-is
    if (/^[1-9][0-2]?[AB]$/i.test(normalized)) {
        return normalized.toUpperCase();
    }
    
    return key; // Return original if no match
}

// DJ Mode state
state.djMode = localStorage.getItem('freedify_dj_mode') === 'true';
state.audioFeaturesCache = {}; // Cache audio features by track ID
state.lastSetlistResult = null;

// Initialize DJ mode on load
if (state.djMode) {
    document.body.classList.add('dj-mode-active');
}

// Toggle DJ mode
djModeBtn?.addEventListener('click', () => {
    state.djMode = !state.djMode;
    localStorage.setItem('freedify_dj_mode', state.djMode);
    document.body.classList.toggle('dj-mode-active', state.djMode);
    
    if (state.djMode) {
        showToast('🎧 DJ Mode activated');
        // Fetch audio features for current queue
        if (state.queue.length > 0) {
            fetchAudioFeaturesForQueue();
        }
    } else {
        showToast('DJ Mode deactivated');
    }
});

// Helper to render DJ Badge
function renderDJBadgeForTrack(track) {
    if (!state.djMode) return '';
    
    // For local tracks, use embedded audio_features directly (trust Serato)
    const isLocal = track.id?.startsWith('local_');
    const feat = isLocal ? track.audio_features : state.audioFeaturesCache[track.id];
    
    if (!feat) return '<div class="dj-badge-placeholder" data-id="' + track.id + '"></div>';
    
    const camelotClass = feat.camelot ? `camelot-${feat.camelot}` : '';
    return `
        <div class="dj-badge-container" style="display: flex;">
            <span class="dj-badge bpm-badge">${feat.bpm} BPM</span>
            <span class="dj-badge camelot-badge ${camelotClass}">${feat.camelot}</span>
        </div>
    `;
}

// Generic fetch features for any list of tracks
async function fetchAudioFeaturesForTracks(tracks) {
    if (!state.djMode || !tracks || tracks.length === 0) return;

    // Filter out already cached AND local files (trust local metadata)
    const tracksToFetch = tracks
        .filter(t => t.id && !t.id.startsWith('LINK:') && !t.id.startsWith('pod_') && !t.id.startsWith('local_'))
        .filter(t => !state.audioFeaturesCache[t.id])
        .map(t => ({
            id: t.id,
            isrc: t.isrc || null,
            name: t.name || null,
            artists: t.artists || null
        }));
    
    // De-duplicate by ID
    const uniqueTracks = [];
    const seenIds = new Set();
    tracksToFetch.forEach(t => {
        if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            uniqueTracks.push(t);
        }
    });
    
    if (uniqueTracks.length === 0) return;
    
    try {
        const response = await fetch('/api/audio-features/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tracks: uniqueTracks })
        });
        
        if (response.ok) {
            const data = await response.json();
            data.features.forEach((feat, i) => {
                if (feat) {
                    state.audioFeaturesCache[uniqueTracks[i].id] = feat;
                }
            });
            // Trigger UI updates
            updateDJBadgesInUI();
            updatePlayerUI(); 
        }
    } catch (err) {
        console.warn('Failed to fetch audio features:', err);
    }
}

// Update all badges in DOM
function updateDJBadgesInUI() {
    // Update placeholders
    $$('.dj-badge-placeholder').forEach(el => {
        const id = el.dataset.id;
        const feat = state.audioFeaturesCache[id];
        if (feat) {
            const camelotClass = feat.camelot ? `camelot-${feat.camelot}` : '';
            el.outerHTML = `
                <div class="dj-badge-container" style="display: flex;">
                    <span class="dj-badge bpm-badge">${feat.bpm} BPM</span>
                    <span class="dj-badge camelot-badge ${camelotClass}">${feat.camelot}</span>
                </div>
            `;
        }
    });

    // Update Player
    if (state.currentIndex >= 0 && state.queue[state.currentIndex]) {
        updatePlayerUI();
    }
}

// Fetch audio features for tracks in queue
async function fetchAudioFeaturesForQueue() {
    await fetchAudioFeaturesForTracks(state.queue);
    addDJBadgesToQueue();
}

// Open DJ setlist modal
function openDJSetlistModal() {
    if (state.queue.length < 3) {
        showToast('Add at least 3 tracks to queue for setlist generation');
        return;
    }
    
    djSetlistModal?.classList.remove('hidden');
    djSetlistLoading?.classList.add('hidden');
    djSetlistResults?.classList.add('hidden');
    djApplyBtn?.classList.add('hidden');
    state.lastSetlistResult = null;
}

function closeDJSetlistModal() {
    djSetlistModal?.classList.add('hidden');
}

djModalClose?.addEventListener('click', closeDJSetlistModal);
djSetlistModal?.addEventListener('click', (e) => {
    if (e.target === djSetlistModal) closeDJSetlistModal();
});

// Generate setlist
djGenerateBtn?.addEventListener('click', async () => {
    // Ensure we have audio features
    await fetchAudioFeaturesForQueue();
    
    // Build tracks data - use embedded audio_features for local, cache for others
    const tracksData = state.queue.map(t => {
        const isLocal = t.id.startsWith('local_');
        const feat = isLocal ? t.audio_features : state.audioFeaturesCache[t.id];
        return {
            id: t.id,
            name: t.name,
            artists: t.artists,
            bpm: feat?.bpm || 0,
            camelot: feat?.camelot || '?',
            energy: feat?.energy || 0.5
        };
    });
    
    djSetlistLoading?.classList.remove('hidden');
    djSetlistResults?.classList.add('hidden');
    
    try {
        const response = await fetch('/api/dj/generate-setlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tracks: tracksData,
                style: djStyleSelect?.value || 'progressive'
            })
        });
        
        if (!response.ok) throw new Error('Generation failed');
        
        const result = await response.json();
        state.lastSetlistResult = result;
        
        // Render results
        renderSetlistResults(result, tracksData);
        
    } catch (err) {
        console.error('Setlist generation error:', err);
        showToast('Failed to generate setlist');
    } finally {
        djSetlistLoading?.classList.add('hidden');
    }
});

function renderSetlistResults(result, tracksData) {
    if (!djOrderedTracks) return;
    
    const trackMap = {};
    tracksData.forEach(t => trackMap[t.id] = t);
    state.queue.forEach(t => trackMap[t.id] = { ...trackMap[t.id], ...t });
    
    let html = '';
    result.ordered_ids.forEach((id, i) => {
        const track = trackMap[id];
        if (!track) return;
        
        // Use embedded audio_features for local tracks, cache for others
        const isLocal = id.startsWith('local_');
        const feat = isLocal ? (track.audio_features || {}) : (state.audioFeaturesCache[id] || {});
        const camelotClass = feat.camelot ? `camelot-${feat.camelot}` : '';
        
        html += `
            <div class="dj-track-item">
                <div class="dj-track-number">${i + 1}</div>
                <div class="dj-track-info">
                    <div class="dj-track-name">${escapeHtml(track.name)}</div>
                    <div class="dj-track-artist">${escapeHtml(track.artists)}</div>
                </div>
                <div class="dj-track-meta">
                    <span class="dj-badge bpm-badge">${feat.bpm || '?'} BPM</span>
                    <span class="dj-badge camelot-badge ${camelotClass}">${feat.camelot || '?'}</span>
                </div>
            </div>
        `;
        
        // Add transition tip if available
        if (i < result.suggestions?.length) {
            const sug = result.suggestions[i];
            const tipClass = sug.harmonic_match ? 'harmonic' : (sug.bpm_diff > 8 ? 'caution' : '');
            const technique = sug.technique ? `<span class="dj-technique-badge">${escapeHtml(sug.technique)}</span>` : '';
            const timing = sug.timing ? `<span class="dj-timing">${escapeHtml(sug.timing)}</span>` : '';
            const tipText = sug.tip ? escapeHtml(sug.tip) : '';
            
            html += `
                <div class="dj-transition ${tipClass}">
                    <div class="dj-transition-header">
                        💡 ${technique} ${timing}
                    </div>
                    <div class="dj-transition-tip">${tipText}</div>
                </div>
            `;
        }
    });
    
    djOrderedTracks.innerHTML = html;
    djSetlistResults?.classList.remove('hidden');
    djApplyBtn?.classList.remove('hidden');
    
    // Show method used
    const methodText = result.method === 'ai-gemini-2.0-flash' ? '✨ AI Generated' : '📊 Algorithm';
    showToast(`${methodText} setlist ready!`);
}

// Apply setlist to queue
djApplyBtn?.addEventListener('click', () => {
    if (!state.lastSetlistResult?.ordered_ids) return;
    
    const trackMap = {};
    state.queue.forEach(t => trackMap[t.id] = t);
    
    const newQueue = [];
    state.lastSetlistResult.ordered_ids.forEach(id => {
        if (trackMap[id]) newQueue.push(trackMap[id]);
    });
    
    // Add any tracks not in the result (shouldn't happen but safety)
    state.queue.forEach(t => {
        if (!newQueue.find(q => q.id === t.id)) {
            newQueue.push(t);
        }
    });
    
    state.queue = newQueue;
    state.currentIndex = 0;
    updateQueueUI();
    
    closeDJSetlistModal();
    showToast('Queue reordered! Ready to mix 🎧');
});

// Add "Generate DJ Set" button to queue header
const queueHeader = $('.queue-header');
if (queueHeader) {
    const djBtn = document.createElement('button');
    djBtn.className = 'dj-generate-set-btn';
    djBtn.innerHTML = '✨ Generate Set';
    djBtn.addEventListener('click', openDJSetlistModal);
    queueHeader.querySelector('.queue-controls')?.prepend(djBtn);
}

// Modify renderQueueItem to show DJ badges (override/extend existing)
const originalUpdateQueue = typeof updateQueueUI !== 'undefined' ? updateQueueUI : null;
function updateQueueWithDJ() {
    originalUpdateQueue?.();
    if (state.djMode && state.queue.length > 0) {
        fetchAudioFeaturesForQueue().then(() => {
            addDJBadgesToQueue();
            // Also update player UI if needed
            if (state.currentIndex >= 0) {
                updatePlayerUI(); 
            }
        });
    }
}

function addDJBadgesToQueue() {
    if (!state.djMode) return;
    
    const queueItems = $$('#queue-container .queue-item');
    queueItems.forEach((item, i) => {
        if (i >= state.queue.length) return;
        const track = state.queue[i];
        const feat = state.audioFeaturesCache[track.id];
        
        // Remove existing badges
        const existing = item.querySelector('.dj-badge-container');
        if (existing) existing.remove();
        
        if (feat) {
            const camelotClass = feat.camelot ? `camelot-${feat.camelot}` : '';
            const badgeContainer = document.createElement('div');
            badgeContainer.className = 'dj-badge-container';
            badgeContainer.innerHTML = `
                <span class="dj-badge bpm-badge">${feat.bpm} BPM</span>
                <span class="dj-badge camelot-badge ${camelotClass}">${feat.camelot}</span>
                <div class="energy-bar"><div class="energy-fill" style="width: ${feat.energy * 100}%"></div></div>
            `;
            item.querySelector('.queue-info')?.appendChild(badgeContainer);
        }
    });
}

// Escape key closes DJ modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !djSetlistModal?.classList.contains('hidden')) {
        closeDJSetlistModal();
    }
});

// ========== LOCAL FILE HANDLING ==========
function initLocalFiles() {
    initDragAndDrop();
    initManualUpload();
}

function initDragAndDrop() {
    // Attach to window to catch drops anywhere
    const dropZone = window;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // Highlight drop zone (using body class)
    window.addEventListener('dragenter', () => document.body.classList.add('dragging'), false);
    window.addEventListener('dragleave', (e) => {
        // Only remove if leaving the window
        if (e.clientX === 0 && e.clientY === 0) {
            document.body.classList.remove('dragging');
        }
    }, false);
    
    window.addEventListener('drop', (e) => {
        document.body.classList.remove('dragging');
        handleDrop(e);
    }, false);
    
    console.log("Drag & Drop initialized on window");
}

function initManualUpload() {
    // const addLocalBtn = document.getElementById('add-local-btn'); // Replaced by Label
    const fileInput = document.getElementById('file-input');
    
    if (fileInput) {
        console.log("Initializing Manual Upload via Label");
        // No click listener needed for Label
        
        fileInput.addEventListener('change', (e) => {
             console.log("File Input Changed", e.target.files);
             if (e.target.files && e.target.files.length > 0) {
                 handleFiles(e.target.files);
             }
        });
    } else {
        console.error("Could not find add-local-btn or file-input");
    }
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles(files);
}

async function handleFiles(files) {
    // alert(`DEBUG: handleFiles called with ${files.length} files`);
    console.log("HandleFiles Entry:", files.length);

    const validExtensions = ['.mp3', '.flac', '.wav', '.aiff', '.aac', '.ogg', '.m4a', '.wma'];
    
    const audioFiles = Array.from(files).filter(file => {
        const isAudio = file.type.startsWith('audio/') || 
                       // Fallback: check extension if type is empty or generic
                       validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
        return isAudio;
    });
    
    // DEBUG: Log files
    // console.log("All files:", files);
    
    if (audioFiles.length === 0) {
        if (files.length > 0) showToast('No supported audio files found', 'error');
        return;
    }

    showLoading(`Processing ${audioFiles.length} local files...`);

    let processedCount = 0;
    for (const file of audioFiles) {
        try {
            const metadata = await extractMetadata(file);
            if (metadata) { 
                addLocalTrackToQueue(file, metadata);
                processedCount++;
            }
        } catch (err) {
            console.error('Error processing file:', file.name, err);
            showToast(`Error reading ${file.name}`, 'error');
        }
    }
    
    hideLoading();
    
    if (processedCount > 0) {
        showToast(`Added ${processedCount} local tracks to queue!`, 'success');
        updateQueueUI();
        if (!state.isPlaying && state.queue.length === processedCount) {
             playTrack(0); // Auto play if queue was empty
        }
    }
}

function extractMetadata(file) {
    return new Promise((resolve) => {
        if (!window.jsmediatags) {
            console.warn("jsmediatags not loaded");
            resolve({ title: file.name, artist: 'Local File' });
            return;
        }

        window.jsmediatags.read(file, {
            onSuccess: (tag) => {
                const tags = tag.tags;
                console.log("Raw tags from jsmediatags:", Object.keys(tags)); // DEBUG: Show all tag names
                
                let picture = null;
                if (tags.picture) {
                    const { data, format } = tags.picture;
                    let base64String = "";
                    for (let i = 0; i < data.length; i++) {
                        base64String += String.fromCharCode(data[i]);
                    }
                    picture = `data:${format};base64,${window.btoa(base64String)}`;
                }

                // Helper to extract tag value (handles both direct and .data formats)
                const getTagValue = (tagName) => {
                    const tag = tags[tagName];
                    if (!tag) return null;
                    if (typeof tag === 'string' || typeof tag === 'number') return tag;
                    if (tag.data !== undefined) return tag.data;
                    return null;
                };

                // Dynamic search: find any tag containing "bpm" in name
                let bpm = null;
                let key = null;
                
                for (const tagName of Object.keys(tags)) {
                    const lowerName = tagName.toLowerCase();
                    const val = getTagValue(tagName);
                    
                    if (!bpm && (lowerName.includes('bpm') || lowerName.includes('beats'))) {
                        bpm = val;
                        console.log(`Found BPM in tag "${tagName}":`, val);
                    }
                    if (!key && (lowerName.includes('key') || lowerName === 'tkey')) {
                        key = val;
                        console.log(`Found Key in tag "${tagName}":`, val);
                    }
                }
                
                // Parse BPM as integer
                if (bpm) bpm = parseInt(String(bpm).replace(/\D/g, ''), 10) || null;
                
                console.log("Final Extracted BPM:", bpm, "Key:", key); // DEBUG

                resolve({
                    title: tags.title || file.name,
                    artist: tags.artist || 'Local Artist',
                    album: tags.album || 'Local Album',
                    bpm: bpm,
                    key: key,
                    picture: picture
                });
            },
            onError: (error) => {
                console.warn('Metadata read error:', error);
                resolve({ title: file.name, artist: 'Local File' });
            }
        });
    });
}

function addLocalTrackToQueue(file, metadata) {
    const blobUrl = URL.createObjectURL(file);
    const safeId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Convert musical key to Camelot notation for color coding
    const camelotKey = musicalKeyToCamelot(metadata.key);
    
    const track = {
        id: safeId,
        name: metadata.title,
        artists: metadata.artist,
        album: metadata.album,
        album_art: metadata.picture || '/static/icon.svg',
        duration: 'Unknown', 
        isrc: safeId,
        audio_features: {
            bpm: metadata.bpm || 0,
            camelot: camelotKey || (metadata.bpm ? '?' : null),
            energy: 0.5, 
            key: -1,
            mode: 1
        },
        src: blobUrl, 
        is_local: true
    };
    
    state.queue.push(track);
}

// Initialize
// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initLocalFiles();
});

// Expose for inline HTML handlers
window.handleFiles = handleFiles;
window.extractMetadata = extractMetadata;

// CSS for drag highlight
const style = document.createElement('style');
style.textContent = `
    body.dragging {
        border: 4px dashed #1db954;
        opacity: 0.8;
    }
`;
document.head.appendChild(style);

// ========== AI RADIO ==========
state.aiRadioActive = false;
state.aiRadioFetching = false;
state.aiRadioSeedTrack = null; // Store original seed track to prevent genre drift
const aiRadioBtn = $('#ai-radio-btn');
let aiRadioStatusEl = null;
let aiRadioInterval = null;

// Toggle AI Radio
if (aiRadioBtn) {
    aiRadioBtn.addEventListener('click', () => {
        console.log('AI Radio button clicked!');
        state.aiRadioActive = !state.aiRadioActive;
        aiRadioBtn.classList.toggle('active', state.aiRadioActive);
        
        if (state.aiRadioActive) {
            // Store the original seed track when AI Radio starts
            const currentTrack = state.queue[Math.max(0, state.currentIndex)];
            state.aiRadioSeedTrack = currentTrack ? {
                name: currentTrack.name,
                artists: currentTrack.artists,
                bpm: currentTrack.audio_features?.bpm,
                camelot: currentTrack.audio_features?.camelot
            } : null;
            console.log('AI Radio seed track:', state.aiRadioSeedTrack);
            
            showAIRadioStatus('AI Radio Active');
            showToast('📻 AI Radio started! Will auto-add similar tracks.');
            checkAndAddTracks(); // Start immediately
            
            // Set up periodic check every 2 minutes (120 seconds)
            aiRadioInterval = setInterval(() => {
                console.log('AI Radio periodic check...');
                checkAndAddTracks();
            }, 120000);
        } else {
            hideAIRadioStatus();
            showToast('📻 AI Radio stopped');
            state.aiRadioSeedTrack = null; // Clear seed track
            
            // Clear the interval
            if (aiRadioInterval) {
                clearInterval(aiRadioInterval);
                aiRadioInterval = null;
            }
        }
    });
} else {
    console.error('AI Radio button not found! #ai-radio-btn');
}

function showAIRadioStatus(message) {
    if (!aiRadioStatusEl) {
        aiRadioStatusEl = document.createElement('div');
        aiRadioStatusEl.className = 'ai-radio-status';
        document.body.appendChild(aiRadioStatusEl);
    }
    aiRadioStatusEl.innerHTML = `
        <span class="spinner-small"></span>
        <span>${message}</span>
    `;
    aiRadioStatusEl.style.display = 'flex';
}

function hideAIRadioStatus() {
    if (aiRadioStatusEl) {
        aiRadioStatusEl.style.display = 'none';
    }
}

async function checkAndAddTracks() {
    if (!state.aiRadioActive || state.aiRadioFetching) return;
    
    const remainingTracks = state.queue.length - Math.max(0, state.currentIndex) - 1;
    console.log('AI Radio check:', { queueLen: state.queue.length, currentIndex: state.currentIndex, remaining: remainingTracks });
    
    // Add more tracks if we have less than 3 remaining
    if (remainingTracks < 3) {
        state.aiRadioFetching = true;
        showAIRadioStatus('Finding similar tracks...');
        
        try {
            // Use the ORIGINAL seed track stored when AI Radio started (prevents genre drift)
            const seed = state.aiRadioSeedTrack;
            
            // Get current queue for exclusion
            const queueTracks = state.queue.map(t => ({
                name: t.name,
                artists: t.artists
            }));
            
            // If no seed, use a default mood
            const requestBody = {
                seed_track: seed,
                mood: seed ? null : "popular music hits",
                current_queue: queueTracks,
                count: 5
            };
            
            console.log('AI Radio request:', requestBody);
            
            const response = await fetch('/api/ai-radio/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            
            if (response.ok) {
                const data = await response.json();
                console.log('AI Radio response:', data);
                const searchTerms = data.search_terms || [];
                
                // Search and add tracks
                let addedCount = 0;
                for (const term of searchTerms) {
                    if (addedCount >= 3) break; // Limit adds per batch
                    
                    try {
                        const searchRes = await fetch(`/api/search?q=${encodeURIComponent(term)}&type=track`);
                        if (searchRes.ok) {
                            const searchData = await searchRes.json();
                            const results = searchData.results || [];
                            
                            // Add first non-duplicate result
                            for (const track of results.slice(0, 3)) {
                                const isDupe = state.queue.some(q => 
                                    q.id === track.id || 
                                    (q.name?.toLowerCase() === track.name?.toLowerCase() && 
                                     q.artists?.toLowerCase() === track.artists?.toLowerCase())
                                );
                                if (!isDupe) {
                                    state.queue.push(track);
                                    addedCount++;
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('AI Radio search error:', e);
                    }
                }
                
                if (addedCount > 0) {
                    updateQueueUI();
                    showToast(`📻 Added ${addedCount} tracks to queue`);
                }
            }
        } catch (err) {
            console.error('AI Radio error:', err);
        }
        
        state.aiRadioFetching = false;
        if (state.aiRadioActive) {
            showAIRadioStatus('AI Radio Active');
        }
    }
}

// Check when current track ends
const originalPlayTrack = window.playTrack || playTrack;
const aiRadioWrappedPlayTrack = async function(index) {
    await originalPlayTrack(index);
    if (state.aiRadioActive) {
        setTimeout(checkAndAddTracks, 1000);
    }
};

// Hook into track end
audioPlayer?.addEventListener('ended', () => {
    if (state.aiRadioActive) {
        setTimeout(checkAndAddTracks, 500);
    }
});

// alert("DEBUG: App.js initialization COMPLETE. If you see this, script is good.");
console.log("App.js initialization COMPLETE");

// ========== ADD TO PLAYLIST MODAL ==========
const playlistModal = $('#playlist-modal');
const playlistList = $('#playlist-list');
const newPlaylistInput = $('#new-playlist-input');
const createPlaylistBtn = $('#create-playlist-btn');
const playlistModalClose = $('#playlist-modal-close');
const addToPlaylistBtn = $('#add-to-playlist-btn');

let pendingTrackForPlaylist = null;

function openAddToPlaylistModal(track) {
    if (!track) {
        showToast('No track selected');
        return;
    }
    pendingTrackForPlaylist = track;
    
    // Render playlist list
    if (state.playlists.length === 0) {
        playlistList.innerHTML = '<p style="color: var(--text-tertiary); text-align:center; padding:16px;">No playlists yet. Create one below!</p>';
    } else {
        playlistList.innerHTML = state.playlists.map(p => `
            <div class="playlist-list-item" data-playlist-id="${p.id}">
                ${escapeHtml(p.name)} <span style="opacity:0.6">(${p.tracks.length})</span>
            </div>
        `).join('');
        
        // Click handler for each playlist item
        playlistList.querySelectorAll('.playlist-list-item').forEach(el => {
            el.addEventListener('click', () => {
                addToPlaylist(el.dataset.playlistId, pendingTrackForPlaylist);
                closeAddToPlaylistModal();
            });
        });
    }
    
    playlistModal.classList.remove('hidden');
}

function closeAddToPlaylistModal() {
    playlistModal.classList.add('hidden');
    pendingTrackForPlaylist = null;
    newPlaylistInput.value = '';
}

// Create new playlist from modal
createPlaylistBtn?.addEventListener('click', () => {
    const name = newPlaylistInput.value.trim();
    if (!name) {
        showToast('Enter a playlist name');
        return;
    }
    
    let tracks = [];
    if (pendingTrackForPlaylist) {
        tracks = Array.isArray(pendingTrackForPlaylist) ? pendingTrackForPlaylist : [pendingTrackForPlaylist];
    }
    
    const newPlaylist = createPlaylist(name, tracks);
    closeAddToPlaylistModal();
});

// Close modal
playlistModalClose?.addEventListener('click', closeAddToPlaylistModal);
playlistModal?.addEventListener('click', (e) => {
    if (e.target === playlistModal) closeAddToPlaylistModal();
});

// Heart button in More Menu -> opens modal for current track
addToPlaylistBtn?.addEventListener('click', () => {
    const currentTrack = state.queue[state.currentIndex];
    if (currentTrack) {
        openAddToPlaylistModal(currentTrack);
        // Close More menu
        $('#player-more-menu')?.classList.add('hidden');
    } else {
        showToast('No track playing');
    }
});

// Expose for queue item hearts (will be wired in updateQueueUI)
window.openAddToPlaylistModal = openAddToPlaylistModal;

// ========== LOAD MORE RESULTS ==========
const loadMoreBtn = $('#load-more-btn');
if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
        if (state.lastSearchQuery) {
            performSearch(state.lastSearchQuery, true);
        }
    });
}

// ========== LISTENBRAINZ LOGIC ==========
// Scrobble Logic
async function submitNowPlaying(track) {
    // ListenBrainz
    if (state.listenBrainzConfig.valid) {
        try {
            await fetch('/api/listenbrainz/now-playing', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(track)
            });
        } catch (e) { console.error('LB Now playing error:', e); }
    }
    // Last.fm
    const lfmSession = localStorage.getItem('lastfm_session_key');
    if (lfmSession) {
        try {
            await fetch('/api/lastfm/nowplaying', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    session_key: lfmSession,
                    artist: track.artists || '',
                    track: track.name || '',
                    album: track.album || ''
                })
            });
        } catch (e) { console.error('Last.fm now playing error:', e); }
    }
}

async function submitScrobble(track) {
    const lbValid = state.listenBrainzConfig.valid;
    const lfmSession = localStorage.getItem('lastfm_session_key');
    
    if ((!lbValid && !lfmSession) || state.scrobbledCurrent) return;
    
    state.scrobbledCurrent = true; // Prevent double scrobble
    
    // ListenBrainz scrobble
    if (lbValid) {
        try {
            await fetch('/api/listenbrainz/scrobble', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(track)
            });
            console.log('LB Scrobbled:', track.name);
        } catch (e) { console.error('LB Scrobble error:', e); }
    }
    
    // Last.fm scrobble
    if (lfmSession) {
        try {
            await fetch('/api/lastfm/scrobble', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    session_key: lfmSession,
                    artist: track.artists || '',
                    track: track.name || '',
                    album: track.album || '',
                    timestamp: Math.floor(Date.now() / 1000)
                })
            });
            console.log('Last.fm Scrobbled:', track.name);
        } catch (e) { console.error('Last.fm Scrobble error:', e); }
    }
}

// Check initial LB status
fetch('/api/listenbrainz/validate')
    .then(res => res.json())
    .then(data => {
        state.listenBrainzConfig = data;
        if (data.valid) console.log('ListenBrainz connected:', data.username);
    })
    .catch(console.error);

// ========== LAST.FM AUTH & UI ==========
(function initLastFM() {
    const lfmUsername = localStorage.getItem('lastfm_username');
    const lfmSessionKey = localStorage.getItem('lastfm_session_key');
    
    // Use the Last.fm button in the More menu
    const lfmBtn = document.getElementById('lastfm-menu-btn');
    if (lfmBtn) {
        // Update button text based on connection state
        if (lfmSessionKey) {
            lfmBtn.textContent = `🎵 Last.fm: ${lfmUsername || 'Connected'}`;
            lfmBtn.classList.add('lastfm-connected');
        } else {
            lfmBtn.textContent = '🎵 Connect Last.fm';
        }
        
        lfmBtn.addEventListener('click', () => {
            // Close the More menu
            document.getElementById('search-more-menu')?.classList.add('hidden');
            
            if (localStorage.getItem('lastfm_session_key')) {
                // Already connected — show disconnect option
                if (confirm(`Connected as ${localStorage.getItem('lastfm_username') || 'Unknown'}.\nDisconnect from Last.fm?`)) {
                    localStorage.removeItem('lastfm_session_key');
                    localStorage.removeItem('lastfm_username');
                    lfmBtn.textContent = '🎵 Connect Last.fm';
                    lfmBtn.classList.remove('lastfm-connected');
                    showToast('Disconnected from Last.fm');
                }
            } else {
                // Start auth flow
                connectLastFM();
            }
        });
    }
    
    // Hook up Import Playlist button
    const importBtn = document.getElementById('import-playlist-menu-btn');
    if (importBtn) {
        importBtn.addEventListener('click', () => {
            document.getElementById('search-more-menu')?.classList.add('hidden');
            document.getElementById('playlist-file-input')?.click();
        });
    }
    
    // Check for pending token (fallback from redirect)
    const pendingToken = localStorage.getItem('lastfm_pending_token');
    if (pendingToken) {
        localStorage.removeItem('lastfm_pending_token');
        exchangeLastFMToken(pendingToken);
    }
    
    // Listen for postMessage from auth popup
    window.addEventListener('message', (event) => {
        if (event.data?.type === 'lastfm-auth' && event.data.token) {
            exchangeLastFMToken(event.data.token);
        }
    });
    
    // Listen for BroadcastChannel (fallback when window.opener is null)
    try {
        const bc = new BroadcastChannel('freedify_lastfm');
        bc.onmessage = (event) => {
            if (event.data?.type === 'lastfm-auth' && event.data.token) {
                exchangeLastFMToken(event.data.token);
            }
        };
    } catch(e) {}
    
    // Check for pending token when window regains focus (fallback if both channels fail)
    window.addEventListener('focus', () => {
        const pt = localStorage.getItem('lastfm_pending_token');
        if (pt) {
            localStorage.removeItem('lastfm_pending_token');
            exchangeLastFMToken(pt);
        }
    });
    
    if (lfmSessionKey) {
        console.log('Last.fm connected:', lfmUsername);
    }
})();

async function connectLastFM() {
    const callbackUrl = `${window.location.origin}/lastfm-callback`;
    try {
        const res = await fetch(`/api/lastfm/auth-url?callback=${encodeURIComponent(callbackUrl)}`);
        const data = await res.json();
        if (data.url) {
            // Open auth in popup
            const popup = window.open(data.url, 'lastfm_auth', 'width=800,height=600,scrollbars=yes');
            if (!popup) {
                // Popup blocked — redirect instead
                window.location.href = data.url;
            }
        }
    } catch (e) {
        console.error('Last.fm auth error:', e);
        showToast('Failed to connect Last.fm');
    }
}

async function exchangeLastFMToken(token) {
    try {
        const res = await fetch('/api/lastfm/callback', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({token})
        });
        
        if (res.ok) {
            const data = await res.json();
            localStorage.setItem('lastfm_session_key', data.session_key);
            localStorage.setItem('lastfm_username', data.username);
            
            // Update button
            const lfmBtn = document.getElementById('lastfm-menu-btn');
            if (lfmBtn) {
                lfmBtn.textContent = `🎵 Last.fm: ${data.username}`;
                lfmBtn.classList.add('lastfm-connected');
            }
            
            showToast(`🎵 Connected to Last.fm as ${data.username}`);
            console.log('Last.fm connected:', data.username);
        } else {
            showToast('Last.fm authorization failed');
        }
    } catch (e) {
        console.error('Last.fm token exchange error:', e);
        showToast('Last.fm connection error');
    }
}

async function renderRecommendations() {
    resultsSection.classList.remove('hidden');
    detailView.classList.add('hidden');
    queueSection.classList.add('hidden');
    
    let html = '';
    
    // ========== SPOTIFY "MADE FOR YOU" SECTION ==========
    // DISABLED: Spotify's sp_dc cookie auth doesn't provide personalized search results.
    // Re-enable when Spotify Developer API access is available with proper OAuth scopes.
    /*
    try {
        const spotifyRes = await fetch('/api/spotify/made-for-you');
        if (spotifyRes.ok) {
            const spotifyPlaylists = await spotifyRes.json();
            
            if (spotifyPlaylists && spotifyPlaylists.length > 0) {
                html += `
                    <div class="results-header">
                        <h2>Spotify For You</h2>
                        <span class="results-count">${spotifyPlaylists.length} playlists</span>
                    </div>
                    <div class="results-grid horizontal-scroll" id="spotify-mfy-grid">
                `;
                
                for (const playlist of spotifyPlaylists) {
                    html += `
                        <div class="album-card spotify-mfy-card" data-id="${playlist.id}">
                            <div class="album-card-art-container">
                                <img class="album-card-art" src="${playlist.image || '/static/icon.png'}" alt="${escapeHtml(playlist.name)}" loading="lazy">
                                <span class="hires-badge" style="background: linear-gradient(135deg, #1db954 0%, #1ed760 100%);">Spotify</span>
                            </div>
                            <div class="album-card-info">
                                <p class="album-card-title">${escapeHtml(playlist.name)}</p>
                                <p class="album-card-artist">${escapeHtml(playlist.owner || 'Spotify')}</p>
                            </div>
                        </div>
                    `;
                }
                
                html += '</div>';
            }
        }
    } catch (e) {
        console.warn('Could not load Spotify Made For You:', e);
    }
    */
    
    // ========== LISTENBRAINZ SECTION ==========
    if (!state.listenBrainzConfig.valid) {
        if (!html) {
            // No Spotify AND no ListenBrainz - show empty state
            resultsContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">✨</div>
                    <p class="empty-text">Connect Spotify or ListenBrainz to see personalized recommendations.</p>
                    <p class="empty-text" style="font-size: 0.9em; opacity: 0.8; margin-top: 8px;">Set SPOTIFY_SP_DC or LISTENBRAINZ_TOKEN in your environment variables.</p>
                </div>
            `;
        } else {
            resultsContainer.innerHTML = html;
            attachSpotifyMFYHandlers();
        }
        return;
    }
    
    showLoading('Loading your ListenBrainz playlists...');
    try {
        // Fetch playlists first
        const playlistsRes = await fetch(`/api/listenbrainz/playlists/${state.listenBrainzConfig.username}`);
        const playlistsData = await playlistsRes.json();
        
        hideLoading();
        
        // Fetch and display stats panel
        try {
            const statsRes = await fetch(`/api/listenbrainz/stats/${state.listenBrainzConfig.username}`);
            if (statsRes.ok) {
                const stats = await statsRes.json();
                if (stats.listen_count > 0) {
                    html += `
                        <div class="stats-panel">
                            <div class="stats-item">
                                <span class="stats-value">${stats.listen_count.toLocaleString()}</span>
                                <span class="stats-label">Total Scrobbles</span>
                            </div>
                            ${stats.top_artists.length > 0 ? `
                            <div class="stats-item top-artists">
                                <span class="stats-label">Top This Week</span>
                                <div class="stats-artists">
                                    ${stats.top_artists.slice(0, 3).map(a => `<span class="artist-tag">${escapeHtml(a.name)}</span>`).join('')}
                                </div>
                            </div>
                            ` : ''}
                        </div>
                    `;
                }
            }
        } catch (e) {
            console.warn('Could not load LB stats:', e);
        }
        
        // Show playlists section
        if (playlistsData.playlists && playlistsData.playlists.length > 0) {
            html += `
                <div class="results-header">
                    <h2>ListenBrainz Playlists</h2>
                    <span class="results-count">${playlistsData.count} playlists</span>
                </div>
                <div class="results-grid" id="lb-playlists-grid">
            `;
            
            for (const playlist of playlistsData.playlists) {
                html += `
                    <div class="album-card lb-playlist-card" data-id="${playlist.id}">
                        <div class="album-card-art-container">
                            <img class="album-card-art" src="/static/icon.svg" alt="${escapeHtml(playlist.name)}" loading="lazy">
                            <span class="hires-badge" style="background: linear-gradient(135deg, #1db954 0%, #1ed760 100%);">LB</span>
                        </div>
                        <div class="album-card-info">
                            <p class="album-card-title">${escapeHtml(playlist.name)}</p>
                            <p class="album-card-artist">${escapeHtml(playlist.artists)}</p>
                            <div class="album-card-meta">
                                <span>${playlist.total_tracks || '?'} tracks</span>
                            </div>
                        </div>
                    </div>
                `;
            }
            
            html += '</div>';
        } else {
            html += `
                <div class="results-header">
                    <h2>ListenBrainz Playlists</h2>
                </div>
                <div class="empty-state" style="margin-bottom: 24px;">
                    <div class="empty-icon">📋</div>
                    <p class="empty-text">No playlists found. Weekly Exploration playlists are generated on Mondays!</p>
                </div>
            `;
        }
        
        resultsContainer.innerHTML = html;
        
        // Attach click handlers for playlist cards
        resultsContainer.querySelectorAll('.lb-playlist-card').forEach(card => {
            card.addEventListener('click', async () => {
                const playlistId = card.dataset.id;
                await openLBPlaylist(playlistId);
            });
        });
        
        attachSpotifyMFYHandlers();
        
    } catch (e) {
        console.error(e);
        showError('Failed to load ListenBrainz data');
    }
}

// Attach click handlers for Spotify "Made For You" cards
function attachSpotifyMFYHandlers() {
    resultsContainer.querySelectorAll('.spotify-mfy-card').forEach(card => {
        card.addEventListener('click', async () => {
            const playlistId = card.dataset.id;
            await openSpotifyPlaylist(playlistId);
        });
    });
}

// Open a Spotify playlist in detail view
async function openSpotifyPlaylist(playlistId) {
    showLoading('Loading playlist tracks...');
    try {
        const res = await fetch(`/api/content/playlist/${playlistId}?source=spotify`);
        const playlist = await res.json();
        
        if (!res.ok) throw new Error(playlist.detail);
        
        hideLoading();
        console.log('Opening Spotify playlist:', playlist.name, playlist);
        
        // Show in detail view
        showDetailView(playlist, playlist.tracks || []);
    } catch (e) {
        console.error('Failed to load Spotify playlist:', e);
        showError('Failed to load playlist');
    }
}

// Open a ListenBrainz playlist in detail view
async function openLBPlaylist(playlistId) {
    showLoading('Loading playlist tracks...');
    try {
        const res = await fetch(`/api/listenbrainz/playlist/${playlistId}`);
        const playlist = await res.json();
        
        if (!res.ok) throw new Error(playlist.detail);
        
        hideLoading();
        console.log('Opening LB playlist:', playlist.name, playlist);
        
        // Show in detail view
        showDetailView(playlist, playlist.tracks || []);
    } catch (e) {
        console.error('Failed to load LB playlist:', e);
        showError('Failed to load playlist');
    }
}

function showToast(message, duration = 3000) {
    let toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    Object.assign(toast.style, {
        position: 'fixed',
        bottom: '80px',
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: 'var(--accent)',
        color: 'white',
        padding: '10px 20px',
        borderRadius: '20px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        zIndex: '10000',
        opacity: '0',
        transition: 'opacity 0.3s',
        pointerEvents: 'none'
    });
    document.body.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => toast.style.opacity = '1');
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ==================== WINAMP MINI PLAYER ====================
async function toggleMiniPlayer() {
    if (!('documentPictureInPicture' in window)) {
        showError('Mini Player not supported in this browser (Chrome/Edge 116+ required)');
        return;
    }
    
    if (pipWindow) {
        pipWindow.close();
        pipWindow = null;
        return;
    }
    
    try {
        pipWindow = await documentPictureInPicture.requestWindow({
            width: 320,
            height: 160,
        });
        
        // Copy Styles
        [...document.styleSheets].forEach((styleSheet) => {
            try {
                const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
                const style = document.createElement('style');
                style.textContent = cssRules;
                pipWindow.document.head.appendChild(style);
            } catch (e) {
                // Ignore CORS errors for external sheets
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.type = styleSheet.type;
                link.media = styleSheet.media;
                link.href = styleSheet.href;
                pipWindow.document.head.appendChild(link);
            }
        });
        
        // Render Winamp HTML
        updateMiniPlayerDOM();
        
        // Bind Controls
        const doc = pipWindow.document;
        doc.getElementById('wa-prev').onclick = () => playPrevious();
        doc.getElementById('wa-play').onclick = () => {
             const p = getActivePlayer();
             if (p.paused) p.play(); else p.pause();
             updateMiniPlayer(); // Immediate update
        };
        doc.getElementById('wa-pause').onclick = () => getActivePlayer().pause();
        doc.getElementById('wa-next').onclick = () => playNext();
        doc.getElementById('wa-vol').oninput = (e) => {
            const val = e.target.value / 100;
            updateVolume(val); // Syncs main slider too
        };
        
        // Force initial update
        updateMiniPlayer();
        
        // Handle Close
        pipWindow.addEventListener('pagehide', () => {
            pipWindow = null;
        });
        
    } catch (err) {
        console.error('Failed to open Mini Player:', err);
    }
}

function updateMiniPlayerDOM() {
    if (!pipWindow) return;
    const doc = pipWindow.document;
    
    // If body is empty, inject structure
    if (!doc.body.children.length) {
        doc.body.className = 'winamp-body';
        doc.body.innerHTML = `
        <div class="winamp-player">
            <div class="winamp-titlebar">
                <div style="width:10px; height:10px; background:#fff; margin-right:4px; clip-path: polygon(50% 0, 0 100%, 100% 100%);"></div>
                <span class="winamp-titlebar-text">FREEDIFY</span>
                <span style="flex:1"></span>
                <div style="background:#808080; width:8px; height:8px; border:1px solid #fff; cursor:pointer;" onclick="window.close()"></div>
            </div>
            <div class="winamp-main">
                <div class="winamp-art">
                     <img id="wa-art" src="" />
                </div>
                <div class="winamp-content">
                    <div class="winamp-display">
                        <div id="wa-time" class="winamp-time">00:00</div>
                        <div id="wa-marquee" class="winamp-marquee"><span>Ready to Llama...</span></div>
                        <div class="winamp-info-line">
                             <span id="wa-format" style="color:#00e000; font-weight:bold;">MP3</span>
                             <span id="wa-state" style="margin-left:8px;">STOP</span>
                        </div>
                    </div>
                    <div class="winamp-controls">
                        <div class="winamp-btn" id="wa-prev" title="Prev"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></div>
                        <div class="winamp-btn" id="wa-play" title="Play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
                        <div class="winamp-btn" id="wa-pause" title="Pause"><svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></div>
                        <div class="winamp-btn" id="wa-next" title="Next"><svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg></div>
                        <div style="font-size: 8px; color: #fff; margin-left: 4px; font-family: 'Courier New', monospace;">VOL</div>
                        <input type="range" class="winamp-slider" id="wa-vol" title="Volume Control" min="0" max="100" value="${state.volume * 100}">
                    </div>
                </div>
            </div>
        </div>
        `;
    }
}

function updateMiniPlayer() {
    if (!pipWindow) return;
    const doc = pipWindow.document;
    const player = getActivePlayer();
    
    // Time
    const cur = player.currentTime || 0;
    const mins = Math.floor(cur / 60);
    const secs = Math.floor(cur % 60);
    const timeStr = `${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}`;
    const timeEl = doc.getElementById('wa-time');
    if (timeEl && timeEl.textContent !== timeStr) timeEl.textContent = timeStr;
    
    // Metadata (Title - Artist)
    const title = $('#player-title').textContent;
    const artist = $('#player-artist').textContent;
    const text = `${artist} - ${title}`;
    const marquee = doc.getElementById('wa-marquee');
    if (marquee) {
        // Update span content or create one if missing
        let span = marquee.querySelector('span');
        if (!span) {
            span = doc.createElement('span');
            marquee.appendChild(span);
        }
        if (span.textContent !== text) span.textContent = text;
    }
    
    // State (Play/Pause/Stop)
    const stateEl = doc.getElementById('wa-state');
    const newState = player.paused ? 'PAUSE' : 'PLAY';
    if (stateEl && stateEl.textContent !== newState) stateEl.textContent = newState;
    
    // Art
    const mainArt = $('#player-art');
    const waArt = doc.getElementById('wa-art');
    if (waArt && mainArt && waArt.src !== mainArt.src) waArt.src = mainArt.src;
    
    // Format
    const badge = $('#audio-format-badge');
    const waFormat = doc.getElementById('wa-format');
    if (waFormat && badge) {
        waFormat.textContent = badge.textContent || 'MP3';
        waFormat.style.color = (badge.textContent === 'HiFi' || badge.textContent === 'FLAC') ? '#00e000' : '#c0c000';
    }
}

// ==================== AI ASSISTANT MODAL ====================

const aiModal = document.getElementById('ai-modal');
const aiModalClose = document.getElementById('ai-modal-close');
const aiModalOverlay = aiModal?.querySelector('.ai-modal-overlay');
const aiMenuBtn = document.getElementById('ai-menu-btn');

// Playlist Generator elements
const aiPlaylistInput = document.getElementById('ai-playlist-input');
const aiPlaylistGenBtn = document.getElementById('ai-playlist-gen-btn');
const aiPlaylistResults = document.getElementById('ai-playlist-results');
const aiDurationSlider = document.getElementById('ai-duration-slider');
const aiDurationLabel = document.getElementById('ai-duration-label');

// Open/Close Modal
function openAIModal() {
    if (aiModal) {
        aiModal.classList.remove('hidden');
        aiPlaylistInput?.focus();
        // Hide menu if open
        document.getElementById('search-more-menu')?.classList.add('hidden');
    }
}

function closeAIModal() {
    if (aiModal) {
        aiModal.classList.add('hidden');
    }
}

// Event listeners
aiMenuBtn?.addEventListener('click', openAIModal);
aiModalClose?.addEventListener('click', closeAIModal);
aiModalOverlay?.addEventListener('click', closeAIModal);

// Duration slider
aiDurationSlider?.addEventListener('input', () => {
    if (aiDurationLabel) {
        aiDurationLabel.textContent = `${aiDurationSlider.value} min`;
    }
});

// Playlist Generator
aiPlaylistGenBtn?.addEventListener('click', async () => {
    const description = aiPlaylistInput?.value?.trim();
    if (!description) return;
    
    const duration = parseInt(aiDurationSlider?.value) || 60;
    
    aiPlaylistGenBtn.disabled = true;
    aiPlaylistResults.innerHTML = '<div class="ai-loading">Generating playlist</div>';
    
    try {
        const res = await fetch('/api/ai/generate-playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description, duration_mins: duration })
        });
        const data = await res.json();
        
        if (data.tracks && data.tracks.length > 0) {
            let html = `
                <div class="ai-results-header">
                    <span>🎵 ${data.playlist_name || 'Generated Playlist'}</span>
                    <span>${data.tracks.length} tracks</span>
                </div>
            `;
            
            data.tracks.forEach((track, i) => {
                html += `
                    <div class="ai-track-item" data-artist="${escapeHtml(track.artist)}" data-title="${escapeHtml(track.title)}">
                        <span style="color: var(--text-tertiary); width: 24px;">${i + 1}</span>
                        <div class="ai-track-info">
                            <div class="ai-track-title">${escapeHtml(track.title)}</div>
                            <div class="ai-track-artist">${escapeHtml(track.artist)}</div>
                        </div>
                    </div>
                `;
            });
            
            html += '<button class="ai-add-all-btn" id="ai-add-all">➕ Add All to Queue</button>';
            
            aiPlaylistResults.innerHTML = html;
            
            // Click handler for individual tracks
            aiPlaylistResults.querySelectorAll('.ai-track-item').forEach(item => {
                item.addEventListener('click', async () => {
                    const searchQuery = `${item.dataset.artist} ${item.dataset.title}`;
                    closeAIModal();
                    searchInput.value = searchQuery;
                    await performSearch(searchQuery);
                });
            });
            
            // Add all button
            document.getElementById('ai-add-all')?.addEventListener('click', async () => {
                closeAIModal();
                const wasEmpty = state.queue.length === 0;
                // Auto-play if queue was empty OR nothing is currently loaded/playing
                const shouldAutoPlay = wasEmpty || !state.currentTrack;
                
                const tracks = data.tracks;
                if (tracks.length === 0) return;

                // Helper to search for a track
                const searchTrack = async (track) => {
                    try {
                        const searchRes = await fetch(`/api/search?q=${encodeURIComponent(track.artist + ' ' + track.title)}&type=track&limit=1`);
                        const searchData = await searchRes.json();
                        if (searchData.results && searchData.results.length > 0) {
                            return searchData.results[0];
                        }
                    } catch (e) {
                        console.error('Failed to find track:', track.title);
                    }
                    return null;
                };

                let hasStartedPlaying = false;

                // 1. Process FIRST track immediately for instant playback
                const firstTrack = tracks[0];
                const firstResult = await searchTrack(firstTrack);
                
                if (firstResult) {
                    addToQueue(firstResult);
                    if (shouldAutoPlay) {
                        playTrack(firstResult);
                        hasStartedPlaying = true;
                    }
                }

                // 2. Process REST in parallel to preserve order but run fast
                if (tracks.length > 1) {
                    const restTracks = tracks.slice(1);
                    // Fetch all in parallel
                    // Note: If list is huge (e.g. 50+), we might want to batch this. 
                    // But for typical AI playlists (10-20), Promise.all is fine.
                    const results = await Promise.all(restTracks.map(t => searchTrack(t)));
                    
                    // Add valid results to queue in order
                    let addedCount = 0;
                    results.forEach(result => {
                        if (result) {
                            addToQueue(result);
                            addedCount++;
                            
                            // Fallback: If first track failed to play/find, play the first valid one we found here
                            if (shouldAutoPlay && !hasStartedPlaying) {
                                playTrack(result);
                                hasStartedPlaying = true;
                            }
                        }
                    });
                    
                    if (addedCount > 0) {
                        showToast(`Added ${addedCount + (firstResult ? 1 : 0)} tracks to queue`);
                    }
                }
            });
        } else {
            aiPlaylistResults.innerHTML = '<p style="color: var(--text-secondary);">Could not generate playlist. Try a different description.</p>';
        }
    } catch (e) {
        console.error('Playlist generation error:', e);
        aiPlaylistResults.innerHTML = '<p style="color: var(--error);">Playlist generation failed. Please try again.</p>';
    } finally {
        aiPlaylistGenBtn.disabled = false;
    }
});

// Close on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && aiModal && !aiModal.classList.contains('hidden')) {
        closeAIModal();
    }
});

console.log('AI Assistant module loaded');

// ========== KEYBOARD SHORTCUTS ==========
// Use existing shortcuts modal
const shortcutsModal = $('#shortcuts-help');
const shortcutsCloseBtn = $('#shortcuts-close');

function openShortcutsModal() {
    if (shortcutsModal) shortcutsModal.classList.remove('hidden');
}

function closeShortcutsModal() {
    if (shortcutsModal) shortcutsModal.classList.add('hidden');
}

if (shortcutsCloseBtn) {
    shortcutsCloseBtn.addEventListener('click', closeShortcutsModal);
}

// Close on backdrop click
if (shortcutsModal) {
    shortcutsModal.addEventListener('click', (e) => {
        if (e.target === shortcutsModal) closeShortcutsModal();
    });
}

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ignore if typing in input
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
    }
    
    // Check for modals first
    if (e.key === 'Escape') {
        if (shortcutsModal && !shortcutsModal.classList.contains('hidden')) {
            closeShortcutsModal();
            return;
        }
        // Other escape handlers exist in their own listeners
    }
    
    // ? - Show shortcuts help
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        openShortcutsModal();
        return;
    }
    
    // / - Focus search
    if (e.key === '/' && !e.shiftKey) {
        e.preventDefault();
        if (searchInput) searchInput.focus();
        return;
    }
    
    // Space - Play/Pause
    if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
        return;
    }
    
    // Arrow Left - Previous track
    if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        playPrevious();
        return;
    }
    
    // Arrow Right - Next track
    if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        playNext();
        return;
    }
    
    // Arrow Up - Volume up
    if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const newVol = Math.min(1, state.volume + 0.1);
        setVolume(newVol);
        return;
    }
    
    // Arrow Down - Volume down
    if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const newVol = Math.max(0, state.volume - 0.1);
        setVolume(newVol);
        return;
    }
    
    // M - Mute/Unmute
    if (e.key.toLowerCase() === 'm') {
        toggleMute();
        return;
    }
    
    // R - Toggle repeat
    if (e.key.toLowerCase() === 'r') {
        cycleRepeatMode();
        return;
    }
    
    // S - Shuffle (if in queue view) (no Shift)
    if (e.key.toLowerCase() === 's' && !e.shiftKey) {
        shuffleQueue();
        return;
    }
    
    // Shift + S - Sync to Drive
    if (e.key.toLowerCase() === 's' && e.shiftKey) {
        e.preventDefault();
        syncBtn?.click();
        return;
    }
    
    // F - Toggle fullscreen player
    if (e.key.toLowerCase() === 'f') {
        toggleFullscreenPlayer();
        return;
    }
    
    // Q - Toggle queue
    if (e.key.toLowerCase() === 'q') {
        toggleQueue();
        return;
    }
    
    // E - Toggle EQ panel
    if (e.key.toLowerCase() === 'e') {
        eqToggleBtn?.click();
        return;
    }
    
    // P - Add current track to Playlist
    if (e.key.toLowerCase() === 'p') {
        // Yield to visualizer controls
        if (visualizerActive && visualizerMode === 'milkdrop') return;
        
        const currentTrack = state.queue[state.currentIndex];
        if (currentTrack && window.openAddToPlaylistModal) {
            window.openAddToPlaylistModal(currentTrack);
        } else {
            showToast('No track playing');
        }
        return;
    }
    
    // H - Toggle HiFi / Hi-Res mode
    if (e.key.toLowerCase() === 'h') {
        hifiBtn?.click();
        return;
    }
    
    // D - Download current track
    if (e.key.toLowerCase() === 'd') {
        downloadCurrentTrack();
        return;
    }
    
    // A - Toggle AI Radio
    if (e.key.toLowerCase() === 'a') {
        aiRadioBtn?.click();
        return;
    }
});

console.log('Keyboard shortcuts loaded');

// ========== INIT: Load persisted state ==========
// Load saved queue on startup
setTimeout(() => {
    loadQueueFromStorage();
    // Apply saved volume to audio players AND slider UI
    audioPlayer.volume = state.volume;
    audioPlayer2.volume = state.volume;
    if (volumeSlider) {
        volumeSlider.value = Math.round(state.volume * 100);
    }
    console.log(`Volume restored: ${Math.round(state.volume * 100)}%`);
}, 100);

// ========== LYRICS MODAL ==========
const lyricsBtn = $('#lyrics-btn');
const fsLyricsBtn = $('#fs-lyrics-btn');
const lyricsModal = $('#lyrics-modal');
const lyricsModalClose = $('#lyrics-modal-close');
const lyricsModalArt = $('#lyrics-modal-art');
const lyricsModalTitle = $('#lyrics-modal-title');
const lyricsModalArtist = $('#lyrics-modal-artist');
const lyricsModalAlbum = $('#lyrics-modal-album');
const lyricsLoading = $('#lyrics-loading');
const lyricsText = $('#lyrics-text');
const lyricsNotFound = $('#lyrics-not-found');
const lyricsSearchLink = $('#lyrics-search-link');
const aboutDescription = $('#about-description');
const aboutRelease = $('#about-release');
const aboutWriters = $('#about-writers');
const aboutProducers = $('#about-producers');
const geniusLink = $('#genius-link');
const annotationsList = $('#annotations-list');
const annotationsEmpty = $('#annotations-empty');
const lyricsTabs = document.querySelectorAll('.lyrics-tab');
const lyricsPanels = document.querySelectorAll('.lyrics-panel');

let currentLyricsData = null;

async function openLyricsModal() {
    const track = state.queue[state.currentIndex];
    if (!track) {
        showToast('No track playing');
        return;
    }
    
    // Show modal and loading state
    lyricsModal.classList.remove('hidden');
    lyricsLoading.classList.remove('hidden');
    lyricsText.textContent = '';
    lyricsNotFound.classList.add('hidden');
    aboutDescription.textContent = '';
    aboutRelease.textContent = '';
    aboutWriters.textContent = '';
    aboutProducers.textContent = '';
    
    // Set header info
    lyricsModalArt.src = track.album_art || '/static/icon.svg';
    lyricsModalTitle.textContent = track.name || 'Unknown';
    lyricsModalArtist.textContent = track.artists || 'Unknown Artist';
    lyricsModalAlbum.textContent = track.album || '';
    
    // Reset to lyrics tab
    lyricsTabs.forEach(t => t.classList.remove('active'));
    lyricsPanels.forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="lyrics"]')?.classList.add('active');
    document.getElementById('lyrics-panel')?.classList.add('active');
    
    // Fetch lyrics
    try {
        const artist = track.artists || '';
        const title = track.name || '';
        const response = await fetch(`/api/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
        const data = await response.json();
        
        currentLyricsData = data;
        lyricsLoading.classList.add('hidden');
        
        if (data.found && data.lyrics) {
            lyricsText.textContent = data.lyrics;
            lyricsNotFound.classList.add('hidden');
        } else {
            lyricsText.textContent = '';
            lyricsNotFound.classList.remove('hidden');
            lyricsSearchLink.href = `https://genius.com/search?q=${encodeURIComponent(artist + ' ' + title)}`;
        }
        
        // Populate About tab
        if (data.about) {
            aboutDescription.textContent = data.about;
        } else {
            aboutDescription.textContent = 'No description available for this track.';
        }
        
        if (data.release_date) {
            aboutRelease.innerHTML = `<strong>Released:</strong> ${data.release_date}`;
        }
        if (data.writers && data.writers.length > 0) {
            aboutWriters.innerHTML = `<strong>Written by:</strong> ${data.writers.join(', ')}`;
        }
        if (data.producers && data.producers.length > 0) {
            aboutProducers.innerHTML = `<strong>Produced by:</strong> ${data.producers.join(', ')}`;
        }
        if (data.genius_url) {
            geniusLink.href = data.genius_url;
            geniusLink.classList.remove('hidden');
        } else {
            geniusLink.classList.add('hidden');
        }
        
        // Populate Annotations tab
        if (data.annotations && data.annotations.length > 0) {
            annotationsList.innerHTML = data.annotations.map(ann => `
                <div class="annotation-item">
                    <div class="annotation-fragment">"${ann.fragment}"</div>
                    <div class="annotation-text">${ann.text}</div>
                </div>
            `).join('');
            annotationsEmpty.classList.add('hidden');
        } else {
            annotationsList.innerHTML = '';
            annotationsEmpty.classList.remove('hidden');
        }
        
    } catch (error) {
        console.error('Lyrics fetch error:', error);
        lyricsLoading.classList.add('hidden');
        lyricsText.textContent = '';
        lyricsNotFound.classList.remove('hidden');
        const artist = track.artists || '';
        const title = track.name || '';
        lyricsSearchLink.href = `https://genius.com/search?q=${encodeURIComponent(artist + ' ' + title)}`;
    }
}

function closeLyricsModal() {
    lyricsModal.classList.add('hidden');
    currentLyricsData = null;
}

// Button handlers
if (lyricsBtn) {
    lyricsBtn.addEventListener('click', openLyricsModal);
}
if (fsLyricsBtn) {
    fsLyricsBtn.addEventListener('click', openLyricsModal);
}
if (lyricsModalClose) {
    lyricsModalClose.addEventListener('click', closeLyricsModal);
}

// Close on backdrop click
lyricsModal?.addEventListener('click', (e) => {
    if (e.target === lyricsModal) {
        closeLyricsModal();
    }
});

// Tab switching
lyricsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        
        lyricsTabs.forEach(t => t.classList.remove('active'));
        lyricsPanels.forEach(p => p.classList.remove('active'));
        
        tab.classList.add('active');
        document.getElementById(`${tabName}-panel`)?.classList.add('active');
    });
});

// Add L keyboard shortcut for lyrics
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey) {
        openLyricsModal();
    }
});

console.log('Lyrics modal loaded');

// ========== MUSIC VIDEO ==========
const fsVideoBtn = $('#fs-video-btn');

function openMusicVideo() {
    const track = state.queue[state.currentIndex];
    if (!track) {
        showToast('No track playing');
        return;
    }
    
    const artist = track.artists || '';
    const title = track.name || '';
    const query = `${artist} ${title} official music video`;
    
    // Open YouTube search in new tab
    const youtubeUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    window.open(youtubeUrl, '_blank');
    
    showToast('🎬 Opening YouTube...');
}

// Button handlers
if (fsVideoBtn) {
    fsVideoBtn.addEventListener('click', openMusicVideo);
}

// Also add to more menu video button
const videoBtn = $('#video-btn');
if (videoBtn) {
    videoBtn.addEventListener('click', openMusicVideo);
}

// V keyboard shortcut for video
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.shiftKey) {
            e.preventDefault();
            openVisualizer();
        } else {
            openMusicVideo();
        }
    }
});

console.log('Music video feature loaded');

// Concerts feature removed per user request

// ========== AUDIO VISUALIZER ==========
const visualizerBtn = $('#fs-visualizer-btn');
const visualizerOverlay = $('#visualizer-overlay');
const visualizerCanvas = $('#visualizer-canvas');
const visualizerCanvasWebgl = $('#visualizer-canvas-webgl');
const visualizerClose = $('#visualizer-close');
const vizTrackName = $('#viz-track-name');
const vizTrackArtist = $('#viz-track-artist');
const vizModeBtns = document.querySelectorAll('.viz-mode-btn');

let visualizerActive = false;
let visualizerMode = 'bars';
let vizAnalyser = null;
let animationId = null;
let particles = [];

// Butterchurn (MilkDrop) variables
let butterchurnVisualizer = null;
let butterchurnPresets = [];
let butterchurnPresetNames = [];
let currentPresetIndex = 0;

function initButterchurn() {
    const bc = window.butterchurn?.default || window.butterchurn;
    if (butterchurnVisualizer || !bc) {
        if (!bc) console.error('Butterchurn library not found on window object');
        return null;
    }
    
    try {
        const canvas = visualizerCanvasWebgl || visualizerCanvas; // Fallback if element missing
        butterchurnVisualizer = bc.createVisualizer(
            audioContext,
            canvas,
            {
                width: canvas.width,
                height: canvas.height,
                pixelRatio: window.devicePixelRatio || 1,
                textureRatio: 1
            }
        );
        
        // Load presets
        let presets = window.butterchurnPresets?.default || window.butterchurnPresets;
        if (presets) {
            // Check if it's a module with getPresets
            if (typeof presets.getPresets === 'function') {
                presets = presets.getPresets();
            }
            
            butterchurnPresets = presets;
            butterchurnPresetNames = Object.keys(butterchurnPresets);
            console.log(`Loaded ${butterchurnPresetNames.length} MilkDrop presets`);
            
            // Load a random preset to start
            if (butterchurnPresetNames.length > 0) {
                currentPresetIndex = Math.floor(Math.random() * butterchurnPresetNames.length);
                loadButterchurnPreset(currentPresetIndex);
            }
        }
        
        // Connect to audio
        butterchurnVisualizer.connectAudio(vizAnalyser || volumeBoostGain);
        
        console.log('Butterchurn initialized');
        return butterchurnVisualizer;
    } catch (e) {
        console.error('Failed to init Butterchurn:', e);
        return null;
    }
}

function loadButterchurnPreset(index) {
    if (!butterchurnVisualizer || butterchurnPresetNames.length === 0) return;
    
    // Ensure index is valid
    if (index < 0) index = butterchurnPresetNames.length - 1;
    if (index >= butterchurnPresetNames.length) index = 0;
    currentPresetIndex = index;
    
    const presetName = butterchurnPresetNames[index];
    const preset = butterchurnPresets[presetName];
    
    console.log(`Loading preset [${index}]: ${presetName}`, preset ? 'found' : 'missing');
    
    if (preset) {
        try {
            butterchurnVisualizer.loadPreset(preset, 1.0); // 1.0 = blend time
            showToast(`🎆 ${presetName}`);
        } catch (err) {
            console.error('Error loading preset:', err);
        }
    }
}

function nextButterchurnPreset() {
    console.log('Next preset clicked');
    loadButterchurnPreset(currentPresetIndex + 1);
}

function prevButterchurnPreset() {
    console.log('Prev preset clicked');
    loadButterchurnPreset(currentPresetIndex - 1);
}

function randomButterchurnPreset() {
    currentPresetIndex = Math.floor(Math.random() * butterchurnPresetNames.length);
    loadButterchurnPreset(currentPresetIndex);
}

function initVisualizerAnalyser() {
    if (vizAnalyser) return;
    
    // We need to use the existing audioContext from the equalizer
    // First ensure EQ is initialized (which creates the audioContext)
    if (!audioContext) {
        initEqualizer();
    }
    
    if (!audioContext) {
        console.error('No audio context available for visualizer');
        return;
    }
    
    try {
        // Create analyser and connect it to the audio chain
        vizAnalyser = audioContext.createAnalyser();
        vizAnalyser.fftSize = 256;
        vizAnalyser.smoothingTimeConstant = 0.8;
        
        // Connect the volumeBoostGain to the analyser, then analyser to destination
        // We need to disconnect volumeBoostGain from destination first
        // Actually, let's just connect analyser in parallel to monitor the output
        if (volumeBoostGain) {
            volumeBoostGain.connect(vizAnalyser);
        } else {
            // If no EQ chain, try direct connection (fallback)
            console.warn('No volumeBoostGain, visualizer may not work well');
        }
        
        console.log('Visualizer analyser connected to audio chain');
    } catch (e) {
        console.error('Failed to init visualizer analyser:', e);
    }
}

function drawBars(ctx, dataArray, width, height) {
    const barCount = 64;
    const barWidth = width / barCount - 2;
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, '#ec4899');
    gradient.addColorStop(0.5, '#f59e0b');
    gradient.addColorStop(1, '#10b981');
    
    for (let i = 0; i < barCount; i++) {
        const barHeight = (dataArray[i] / 255) * height * 0.8;
        const x = i * (barWidth + 2);
        
        ctx.fillStyle = gradient;
        ctx.fillRect(x, height - barHeight, barWidth, barHeight);
        
        // Mirror reflection
        ctx.globalAlpha = 0.3;
        ctx.fillRect(x, height, barWidth, barHeight * 0.3);
        ctx.globalAlpha = 1;
    }
}

function drawWave(ctx, dataArray, width, height) {
    ctx.beginPath();
    ctx.strokeStyle = '#ec4899';
    ctx.lineWidth = 3;
    
    const sliceWidth = width / dataArray.length;
    let x = 0;
    
    for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 255;
        const y = v * height;
        
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
        x += sliceWidth;
    }
    
    ctx.stroke();
    
    // Draw mirrored wave
    ctx.beginPath();
    ctx.strokeStyle = '#f59e0b';
    ctx.globalAlpha = 0.5;
    x = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 255;
        const y = height - (v * height);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
}


function drawParticles(ctx, dataArray, width, height) {
    // Spawn new particles based on audio intensity
    const avgIntensity = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    
    if (avgIntensity > 100 && particles.length < 200) {
        for (let i = 0; i < 3; i++) {
            particles.push({
                x: Math.random() * width,
                y: height + 10,
                vx: (Math.random() - 0.5) * 4,
                vy: -(Math.random() * 5 + 2),
                size: Math.random() * 6 + 2,
                color: `hsl(${Math.random() * 60 + 300}, 100%, 60%)`,
                life: 1
            });
        }
    }
    
    // Update and draw particles
    particles = particles.filter(p => p.life > 0);
    for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.02; // Gravity
        p.life -= 0.01;
        
        ctx.beginPath();
        const radius = Math.max(0, p.size * p.life);
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function renderVisualizer() {
    if (!visualizerActive || !vizAnalyser) return;
    
    const canvas = visualizerCanvas;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Get frequency data
    const bufferLength = vizAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    vizAnalyser.getByteFrequencyData(dataArray);
    
    // Clear canvas with fade effect
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, 0, width, height);
    
    // Draw based on mode
    switch (visualizerMode) {
        case 'milkdrop':
            // Butterchurn handles its own rendering
            if (butterchurnVisualizer) {
                butterchurnVisualizer.render();
            }
            break;
        case 'bars':
            drawBars(ctx, dataArray, width, height);
            break;
        case 'wave':
            drawWave(ctx, dataArray, width, height);
            break;

        case 'particles':
            drawParticles(ctx, dataArray, width, height);
            break;
    }
    
    animationId = requestAnimationFrame(renderVisualizer);
}

// Visualizer Idle State
let visualizerIdleTimer = null;
let vizInfoBriefTimer = null;
let visualizerListenersAttached = false;

function resetVisualizerIdleTimer() {
    if (!visualizerActive) return;
    
    // Remove idle class (show UI)
    visualizerOverlay.classList.remove('user-idle');
    
    // Clear existing timer
    if (visualizerIdleTimer) clearTimeout(visualizerIdleTimer);
    
    // Set new timer (10s)
    visualizerIdleTimer = setTimeout(() => {
        if (visualizerActive) {
            visualizerOverlay.classList.add('user-idle');
        }
    }, 10000);
}

function showVisualizerInfoBriefly() {
    if (!visualizerActive) return;
    
    // Ensure info is updated
    const track = state.queue[state.currentIndex];
    if (track) {
        vizTrackName.textContent = track.name || 'Unknown Track';
        vizTrackArtist.textContent = track.artists || '';
    }

    // Add temp-visible class
    const info = document.querySelector('.visualizer-track-info');
    if (info) {
        info.classList.add('temp-visible');
        
        if (vizInfoBriefTimer) clearTimeout(vizInfoBriefTimer);
        
        vizInfoBriefTimer = setTimeout(() => {
            info.classList.remove('temp-visible');
        }, 15000); // 15s
    }
}

function initVisualizerIdleState() {
    if (visualizerListenersAttached) return;
    
    const events = ['mousemove', 'mousedown', 'click', 'keydown', 'touchstart'];
    events.forEach(event => {
        document.addEventListener(event, resetVisualizerIdleTimer);
    });
    
    visualizerListenersAttached = true;
    resetVisualizerIdleTimer();
}

function openVisualizer() {
    const track = state.queue[state.currentIndex];
    if (!track) {
        showToast('Play a track first');
        return;
    }
    
    // Initialize visualizer analyser (uses existing audioContext from EQ)
    initVisualizerAnalyser();
    if (audioContext?.state === 'suspended') {
        audioContext.resume();
    }
    
    // Init idle state
    initVisualizerIdleState();
    visualizerOverlay.classList.remove('user-idle');
    
    // Update track info
    vizTrackName.textContent = track.name || 'Unknown Track';
    vizTrackArtist.textContent = track.artists || '';
    
    // Set canvas size
    visualizerCanvas.width = window.innerWidth;
    visualizerCanvas.height = window.innerHeight;
    if (visualizerCanvasWebgl) {
        visualizerCanvasWebgl.width = window.innerWidth;
        visualizerCanvasWebgl.height = window.innerHeight;
    }
    
    // Initial visibility
    if (visualizerMode === 'milkdrop') {
        if (!butterchurnVisualizer) initButterchurn();
        visualizerCanvasWebgl?.classList.remove('hidden');
        visualizerCanvas?.classList.add('hidden');
    } else {
        visualizerCanvasWebgl?.classList.add('hidden');
        visualizerCanvas?.classList.remove('hidden');
    }
    
    // Show overlay
    visualizerOverlay.classList.remove('hidden');
    visualizerActive = true;
    
    // Start rendering
    renderVisualizer();
}

function closeVisualizer() {
    visualizerActive = false;
    visualizerOverlay.classList.add('hidden');
    
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
}

// Button handlers
if (visualizerBtn) {
    visualizerBtn.addEventListener('click', openVisualizer);
}
// Also add to more menu visualizer button
const menuVisualizerBtn = $('#menu-visualizer-btn');
if (menuVisualizerBtn) {
    menuVisualizerBtn.addEventListener('click', openVisualizer);
}

if (visualizerClose) {
    visualizerClose.addEventListener('click', closeVisualizer);
}

// Close on ESC
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visualizerActive) {
        closeVisualizer();
    }
    
    // N for Next Preset (MilkDrop)
    if ((e.key === 'n' || e.key === 'N') && visualizerActive && visualizerMode === 'milkdrop') {
        nextButterchurnPreset();
    }
    
    // P for Prev Preset (MilkDrop)
    if ((e.key === 'p' || e.key === 'P') && visualizerActive && visualizerMode === 'milkdrop') {
        prevButterchurnPreset();
    }
});

// Mode switching
vizModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        // Toggle preset button visibility
        const isMilkDrop = btn.dataset.mode === 'milkdrop';
        const nextPresetBtn = document.getElementById('viz-next-preset');
        const prevPresetBtn = document.getElementById('viz-prev-preset');
        
        if (nextPresetBtn) nextPresetBtn.style.display = isMilkDrop ? 'block' : 'none';
        if (prevPresetBtn) prevPresetBtn.style.display = isMilkDrop ? 'block' : 'none';
        
        // Handle normal mode switching
        if (!btn.id || (btn.id !== 'viz-next-preset' && btn.id !== 'viz-prev-preset')) {
            vizModeBtns.forEach(b => {
                if (b.id !== 'viz-next-preset' && b.id !== 'viz-prev-preset') b.classList.remove('active');
            });
            btn.classList.add('active');
            visualizerMode = btn.dataset.mode;
            particles = []; // Clear particles when switching modes
            
            // Init Butterchurn if needed
            if (visualizerMode === 'milkdrop') {
                if (!butterchurnVisualizer) initButterchurn();
                // Toggle canvases
                if (visualizerCanvasWebgl) {
                    visualizerCanvasWebgl.classList.remove('hidden');
                    visualizerCanvas.classList.add('hidden');
                }
            } else {
                // Toggle canvases
                if (visualizerCanvasWebgl) {
                    visualizerCanvasWebgl.classList.add('hidden');
                    visualizerCanvas.classList.remove('hidden');
                }
            }
        }
    });
});

const vizNextPresetBtn = document.getElementById('viz-next-preset');
if (vizNextPresetBtn) {
    vizNextPresetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        nextButterchurnPreset();
    });
}
const vizPrevPresetBtn = document.getElementById('viz-prev-preset');
if (vizPrevPresetBtn) {
    vizPrevPresetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        prevButterchurnPreset();
    });
}

// Handle window resize
window.addEventListener('resize', () => {
    if (visualizerActive) {
        visualizerCanvas.width = window.innerWidth;
        visualizerCanvas.height = window.innerHeight;
        
        if (visualizerCanvasWebgl) {
            visualizerCanvasWebgl.width = window.innerWidth;
            visualizerCanvasWebgl.height = window.innerHeight;
        }
        
        if (butterchurnVisualizer) {
            butterchurnVisualizer.setRendererSize(window.innerWidth, window.innerHeight);
        }
    }
});

console.log('Audio visualizer loaded');

// ========== CONCERT ALERTS ==========

const concertModal = $('#concert-modal');
const concertModalClose = $('#concert-modal-close');
const concertMenuBtn = $('#concert-search-menu-btn');
const concertResults = $('#concert-results');
const concertLoading = $('#concert-loading');
const concertEmpty = $('#concert-empty');
const concertArtistSearch = $('#concert-artist-search');
const concertSearchBtn = $('#concert-search-btn');
const concertTabs = $$('.concert-tab');
const concertRecentSection = $('#concert-recent-section');
const concertSearchSection = $('#concert-search-section');

// Concert State
const concertState = {
    currentTab: 'recent'
};

// Open Concert Modal (optionally with artist pre-filled from main search)
function openConcertModal(artistQuery = null) {
    concertModal?.classList.remove('hidden');
    
    // If artist query provided, switch to search tab and auto-search
    if (artistQuery && artistQuery.trim()) {
        concertState.currentTab = 'search';
        concertTabs.forEach(t => t.classList.remove('active'));
        concertTabs.forEach(t => { if (t.dataset.tab === 'search') t.classList.add('active'); });
        concertRecentSection?.classList.add('hidden');
        concertSearchSection?.classList.remove('hidden');
        
        if (concertArtistSearch) {
            concertArtistSearch.value = artistQuery.trim();
        }
        searchConcerts(artistQuery.trim());
    } else if (concertState.currentTab === 'recent') {
        // Load concerts for recent artists by default
        loadConcertsForRecentArtists();
    }
}

// Close Concert Modal
function closeConcertModal() {
    concertModal?.classList.add('hidden');
}

// Get unique artists from recent listen history
function getRecentArtists() {
    const artistSet = new Set();
    const artists = [];
    
    // Get from current queue
    state.queue.forEach(track => {
        if (track.artists && !artistSet.has(track.artists)) {
            artistSet.add(track.artists);
            artists.push(track.artists.split(',')[0].trim()); // Take first artist
        }
    });
    
    // Limit to 10 unique artists
    return artists.slice(0, 10);
}

// Load concerts for recent artists
async function loadConcertsForRecentArtists() {
    const artists = getRecentArtists();
    
    if (artists.length === 0) {
        concertResults.innerHTML = '';
        concertEmpty.classList.remove('hidden');
        concertEmpty.querySelector('p').textContent = 'Listen to some music first to see concert recommendations!';
        return;
    }
    
    concertLoading.classList.remove('hidden');
    concertEmpty.classList.add('hidden');
    concertResults.innerHTML = '';
    
    try {
        const response = await fetch(`/api/concerts/for-artists?artists=${encodeURIComponent(artists.join(','))}`);
        const data = await response.json();
        
        concertLoading.classList.add('hidden');
        
        if (data.events && data.events.length > 0) {
            renderConcertCards(data.events);
        } else {
            concertEmpty.classList.remove('hidden');
            concertEmpty.querySelector('p').textContent = 'No upcoming concerts found for your recent artists';
        }
    } catch (error) {
        console.error('Concert fetch error:', error);
        concertLoading.classList.add('hidden');
        concertEmpty.classList.remove('hidden');
        concertEmpty.querySelector('p').textContent = 'Failed to load concerts. Check API keys.';
    }
}

// Search concerts for a specific artist
async function searchConcerts(artist) {
    if (!artist.trim()) return;
    
    concertLoading.classList.remove('hidden');
    concertEmpty.classList.add('hidden');
    concertResults.innerHTML = '';
    
    try {
        const response = await fetch(`/api/concerts/search?artist=${encodeURIComponent(artist)}`);
        const data = await response.json();
        
        concertLoading.classList.add('hidden');
        
        if (data.events && data.events.length > 0) {
            renderConcertCards(data.events);
        } else {
            concertEmpty.classList.remove('hidden');
            concertEmpty.querySelector('p').textContent = `No upcoming concerts found for "${artist}"`;
        }
    } catch (error) {
        console.error('Concert search error:', error);
        concertLoading.classList.add('hidden');
        concertEmpty.classList.remove('hidden');
        concertEmpty.querySelector('p').textContent = 'Search failed. Check API keys.';
    }
}

// Render concert cards
function renderConcertCards(events) {
    concertResults.innerHTML = events.map(event => {
        const date = event.date ? new Date(event.date + 'T00:00:00').toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }) : 'TBA';
        
        const time = event.time ? formatConcertTime(event.time) : '';
        const location = [event.city, event.state, event.country].filter(Boolean).join(', ');
        const priceRange = event.price_min && event.price_max 
            ? `$${Math.round(event.price_min)} - $${Math.round(event.price_max)}`
            : event.price_min 
                ? `From $${Math.round(event.price_min)}`
                : '';
        
        return `
            <div class="concert-card">
                ${event.image 
                    ? `<img class="concert-card-image" src="${event.image}" alt="${event.artist}" onerror="this.outerHTML='<div class=\\'concert-card-image placeholder\\'>🎵</div>'">`
                    : '<div class="concert-card-image placeholder">🎵</div>'
                }
                <div class="concert-card-info">
                    <div class="concert-card-artist">
                        ${event.artist || event.name}
                        <span class="concert-source-badge">${event.source}</span>
                    </div>
                    <div class="concert-card-venue">📍 ${event.venue}${location ? `, ${location}` : ''}</div>
                    <div class="concert-card-date">📅 ${date}${time ? ` • ${time}` : ''}</div>
                    ${priceRange ? `<div class="concert-card-price">💰 ${priceRange}</div>` : ''}
                </div>
                <div class="concert-card-actions">
                    ${event.ticket_url 
                        ? `<a href="${event.ticket_url}" target="_blank" rel="noopener" class="concert-ticket-btn">🎫 Tickets</a>`
                        : ''
                    }
                </div>
            </div>
        `;
    }).join('');
}

// Format time from HH:MM:SS to readable
function formatConcertTime(timeStr) {
    if (!timeStr) return '';
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
}

// Event Listeners
concertMenuBtn?.addEventListener('click', () => {
    // Get text from main search input if any
    const mainSearchInput = $('#search-input');
    const artistQuery = mainSearchInput?.value || '';
    openConcertModal(artistQuery);
    // Close the more menu
    $('#search-more-menu')?.classList.add('hidden');
});
concertModalClose?.addEventListener('click', closeConcertModal);
concertModal?.addEventListener('click', (e) => {
    if (e.target === concertModal) closeConcertModal();
});

// Tab switching
concertTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        concertState.currentTab = tabName;
        
        // Update active tab
        concertTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Show/hide sections
        if (tabName === 'recent') {
            concertRecentSection.classList.remove('hidden');
            concertSearchSection.classList.add('hidden');
            loadConcertsForRecentArtists();
        } else {
            concertRecentSection.classList.add('hidden');
            concertSearchSection.classList.remove('hidden');
            concertResults.innerHTML = '';
            concertEmpty.classList.add('hidden');
        }
    });
});

// Search button
concertSearchBtn?.addEventListener('click', () => {
    searchConcerts(concertArtistSearch?.value || '');
});

// Search on Enter
concertArtistSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        searchConcerts(concertArtistSearch.value);
    }
});

console.log('Concert alerts loaded');

// ==================== ARTIST BIO MODAL ====================
const artistBioModal = $('#artist-bio-modal');
const artistBioClose = $('#artist-bio-close');
const artistBioOverlay = $('#artist-bio-overlay');
const artistBioImg = $('#artist-bio-img');
const artistBioName = $('#artist-bio-name');
const artistBioGenres = $('#artist-bio-genres');
const artistBioText = $('#artist-bio-text');
const artistBioSocials = $('#artist-bio-socials');
const artistSocialsSection = $('#artist-socials-section');

function closeArtistBio() {
    artistBioModal?.classList.add('hidden');
}

artistBioClose?.addEventListener('click', closeArtistBio);
artistBioOverlay?.addEventListener('click', closeArtistBio);

// Handle downward drag/swipe to close (simple implementation)
const artistBioContent = $('.artist-bio-content');
let bioStartY = 0;
artistBioContent?.addEventListener('touchstart', e => {
    bioStartY = e.touches[0].clientY;
}, {passive: true});
artistBioContent?.addEventListener('touchend', e => {
    const endY = e.changedTouches[0].clientY;
    if (endY - bioStartY > 100) { // Dragged down significantly
        closeArtistBio();
    }
});

async function showArtistBio(artistName) {
    if (!artistName || artistName === 'Unknown' || artistName === '-') return;
    
    // Show modal, set loading state
    artistBioModal?.classList.remove('hidden');
    if (artistBioName) artistBioName.textContent = artistName;
    if (artistBioImg) artistBioImg.src = '/static/icon.svg';
    if (artistBioGenres) artistBioGenres.innerHTML = '';
    if (artistBioText) {
        artistBioText.innerHTML = '';
        artistBioText.classList.add('loading-pulse');
    }
    if (artistBioSocials) artistBioSocials.innerHTML = '';
    artistSocialsSection?.classList.add('hidden');
    
    try {
        const res = await fetch(`/api/artist/${encodeURIComponent(artistName)}/bio`);
        if (!res.ok) throw new Error('Artist not found');
        const data = await res.json();
        
        artistBioText?.classList.remove('loading-pulse');
        
        if (data.image && artistBioImg) {
            artistBioImg.src = data.image;
        }
        
        if (data.genres && data.genres.length > 0 && artistBioGenres) {
            artistBioGenres.innerHTML = data.genres.map(g => `<span class="genre-pill">${escapeHtml(g)}</span>`).join('');
        }
        
        if (artistBioText) {
            if (data.bio) {
                artistBioText.innerHTML = data.bio;
            } else {
                artistBioText.innerHTML = '<em>No biography available.</em>';
            }
        }
        
        if (data.socials && data.socials.length > 0 && artistSocialsSection && artistBioSocials) {
            artistSocialsSection.classList.remove('hidden');
            artistBioSocials.innerHTML = data.socials.map(s => `
                <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" class="social-link">
                    <span class="social-icon">${s.icon}</span>
                    <span>${escapeHtml(s.label)}</span>
                </a>
            `).join('');
        }
        
    } catch (e) {
        console.error('Artist bio error:', e);
        artistBioText?.classList.remove('loading-pulse');
        if (artistBioText) {
            artistBioText.innerHTML = '<em>Could not load artist information.</em>';
        }
    }
    
    // Fetch similar artists
    const similarSection = $('#artist-similar-section');
    const similarList = $('#artist-bio-similar');
    if (similarSection && similarList) {
        similarSection.classList.add('hidden');
        similarList.innerHTML = '';
        
        try {
            const simRes = await fetch(`/api/lastfm/artist/${encodeURIComponent(artistName)}/similar`);
            if (simRes.ok) {
                const simData = await simRes.json();
                if (simData.artists && simData.artists.length > 0) {
                    similarSection.classList.remove('hidden');
                    similarList.innerHTML = simData.artists.map(a => {
                        const safeName = escapeHtml(a.name).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
                        return `
                        <div class="similar-artist-chip" onclick="showArtistBio(this.dataset.artist)" data-artist="${safeName}">
                            <span class="similar-artist-name">${escapeHtml(a.name)}</span>
                        </div>
                    `}).join('');
                }
            }
        } catch (e) {
            console.error('Similar artists error:', e);
        }
    }
}

// Bind clicks to dynamically open artist bio (only from player bar)
document.addEventListener('click', (e) => {
    const target = e.target;
    if (
        target.id === 'player-artist' || 
        target.id === 'fs-artist'
    ) {
        e.preventDefault();
        e.stopPropagation();
        const artistName = target.textContent.trim();
        showArtistBio(artistName);
    }
});

// ==================== PLAYLIST EXPORT ====================
const detailExportBtn = $('#detail-export-btn');
const detailExportMenu = $('#detail-export-menu');
const queueExportBtn = $('#queue-export-btn');
const queueExportMenu = $('#queue-export-menu');

// Toggle dropdowns
detailExportBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    detailExportMenu.classList.toggle('hidden');
    if (queueExportMenu) queueExportMenu.classList.add('hidden');
});

queueExportBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    queueExportMenu.classList.toggle('hidden');
    if (detailExportMenu) detailExportMenu.classList.add('hidden');
});

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.export-dropdown-container')) {
        detailExportMenu?.classList.add('hidden');
        queueExportMenu?.classList.add('hidden');
    }
});

// Handle export option click
document.addEventListener('click', (e) => {
    const option = e.target.closest('.export-option');
    if (!option) return;
    
    e.preventDefault();
    const target = option.dataset.target; // 'detail' or 'queue'
    const format = option.dataset.format; // 'm3u', 'csv', 'json'
    
    let tracks = [];
    let title = 'Playlist';
    
    if (target === 'detail') {
        tracks = state.detailTracks || [];
        title = state.detailName || 'Exported_Playlist';
    } else if (target === 'queue') {
        tracks = state.queue || [];
        title = 'Freedify_Queue';
    }
    
    if (tracks.length === 0) {
        showToast('No tracks to export');
        return;
    }
    
    exportPlaylist(tracks, format, title.replace(/[^a-z0-9]/gi, '_'));
    
    // Hide menus
    detailExportMenu?.classList.add('hidden');
    queueExportMenu?.classList.add('hidden');
});

function exportPlaylist(tracks, format, filename) {
    let content = '';
    let type = 'text/plain;charset=utf-8';
    
    switch (format) {
        case 'm3u':
            content = generateM3U(tracks);
            type = 'audio/x-mpegurl;charset=utf-8';
            filename += '.m3u';
            break;
        case 'csv':
            content = generateCSV(tracks);
            type = 'text/csv;charset=utf-8';
            filename += '.csv';
            break;
        case 'json':
            content = JSON.stringify(tracks, null, 2);
            type = 'application/json;charset=utf-8';
            filename += '.json';
            break;
        default:
            return;
    }
    
    triggerDownload(content, filename, type);
    showToast(`Exported ${tracks.length} tracks to ${format.toUpperCase()}`);
}

function generateM3U(tracks) {
    let m3u = '#EXTM3U\n';
    tracks.forEach(track => {
        const durationSeconds = track.duration ? Math.round(track.duration) : -1;
        m3u += `#EXTINF:${durationSeconds},${track.artists} - ${track.name}\n`;
        // We use ISRC as the URI if streamUrl is not immediately available
        m3u += `freedify://track/${track.isrc || track.id}\n`;
    });
    return m3u;
}

function generateCSV(tracks) {
    const escapeCSV = (str) => {
        if (!str) return '""';
        const cleaned = String(str).replace(/"/g, '""');
        return `"${cleaned}"`;
    };
    
    let csv = 'Name,Artist,Album,Duration(s),ISRC,Source\n';
    tracks.forEach(track => {
        const row = [
            escapeCSV(track.name),
            escapeCSV(track.artists),
            escapeCSV(track.album),
            track.duration || '',
            escapeCSV(track.isrc),
            escapeCSV(track.source)
        ].join(',');
        csv += row + '\n';
    });
    return csv;
}

function triggerDownload(content, filename, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

// ==================== PLAYLIST IMPORT ====================
async function handlePlaylistImport(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const text = await file.text();
    let importedTracks = [];
    
    try {
        if (ext === 'json') {
            const data = JSON.parse(text);
            importedTracks = Array.isArray(data) ? data : (data.tracks || []);
        } else if (ext === 'm3u' || ext === 'm3u8') {
            const lines = text.split('\n');
            let currentTrack = {};
            for (const line of lines) {
                const l = line.trim();
                if (l.startsWith('#EXTINF:')) {
                    // Extract duration and name (format: #EXTINF:duration,Artist - Title)
                    const parsed = l.match(/#EXTINF:(-?\d+),(.*)/);
                    if (parsed) {
                        currentTrack.duration = Math.max(0, parseInt(parsed[1], 10));
                        const parts = parsed[2].split(' - ');
                        if (parts.length >= 2) {
                            currentTrack.artists = parts[0].trim();
                            currentTrack.name = parts.slice(1).join(' - ').trim();
                        } else {
                            currentTrack.name = parsed[2].trim();
                            currentTrack.artists = 'Unknown Artist';
                        }
                    }
                } else if (l && !l.startsWith('#')) {
                    // URI or path
                    currentTrack.id = l.replace('freedify://track/', '') || `import_${Date.now()}_${Math.random()}`;
                    currentTrack.isrc = currentTrack.id;
                    if (!currentTrack.name) currentTrack.name = l.split('/').pop();
                    importedTracks.push({...currentTrack, source: 'import'});
                    currentTrack = {};
                }
            }
        } else if (ext === 'csv') {
            const lines = text.split('\n').filter(l => l.trim().length > 0);
            if (lines.length > 1) { // Skip header
                for (let i = 1; i < lines.length; i++) {
                    const l = lines[i];
                    // Very simple CSV parse (doesn't handle commas inside quotes well, but enough for basic use)
                    const parts = l.split(',');
                    if (parts.length >= 2) {
                        importedTracks.push({
                            id: `import_${Date.now()}_${i}`,
                            name: parts[0].replace(/"/g, '').trim(),
                            artists: parts[1].replace(/"/g, '').trim(),
                            album: parts[2] ? parts[2].replace(/"/g, '').trim() : '',
                            duration: parts[3] ? parseInt(parts[3]) : 0,
                            isrc: parts[4] ? parts[4].replace(/"/g, '').trim() : '',
                            source: 'import'
                        });
                    }
                }
            }
        }
        
        if (importedTracks.length > 0) {
            const baseName = file.name.replace(/\.[^/.]+$/, "");
            createPlaylist(`Imported: ${baseName}`, importedTracks);
            showToast(`Imported "${baseName}" with ${importedTracks.length} tracks!`);
        } else {
            showToast('Could not parse any tracks from this file');
        }
    } catch (e) {
        console.error('Import error:', e);
        showToast('Error parsing playlist file. Invalid format.');
    }
}

// ========== AUDIOBOOK LOGIC ==========

const audiobookModal = $('#audiobook-modal');
const audiobookCloseBtn = $('#audiobook-modal-close');
let currentAudiobookDetails = null;
let audiobookPollInterval = null;

if (audiobookCloseBtn) {
    audiobookCloseBtn.addEventListener('click', () => {
        audiobookModal.classList.add('hidden');
        if (audiobookPollInterval) {
            clearInterval(audiobookPollInterval);
            audiobookPollInterval = null;
        }
    });
}

async function openAudiobook(id) {
    showLoading('Fetching audiobook details...');
    try {
        const response = await fetch(`/api/audiobooks/details?id=${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error('Failed to fetch audiobook details');
        const details = await response.json();
        hideLoading();
        
        currentAudiobookDetails = details;
        
        // Populate Modal
        $('#audiobook-modal-title').textContent = details.title;
        $('#audiobook-modal-art').src = details.cover_image || '/static/icon.svg';
        $('#audiobook-modal-description').textContent = details.description || 'No description available.';
        
        // Reset UI
        const btn = $('#audiobook-download-btn');
        btn.textContent = '☁️ Download to Premiumize';
        btn.disabled = false;
        
        let favBtn = $('#audiobook-fav-btn');
        if (!favBtn) {
            favBtn = document.createElement('button');
            favBtn.id = 'audiobook-fav-btn';
            btn.parentNode.insertBefore(favBtn, btn.nextSibling);
            favBtn.style.marginTop = '10px';
            
            favBtn.addEventListener('click', () => {
                if (!currentAudiobookDetails) return;
                const bookInfo = {
                    id: id,
                    name: currentAudiobookDetails.title,
                    artist: 'AudiobookBay',
                    artwork: currentAudiobookDetails.cover_image || '/static/icon.svg'
                };
                const nowFav = toggleAudiobookFavorite(bookInfo);
                favBtn.textContent = nowFav ? '❤️ In My Books' : '🤍 Save to My Books';
                favBtn.className = nowFav ? 'btn-secondary saved' : 'btn-secondary';
            });
        }
        
        const isFav = isAudiobookFavorited(id);
        favBtn.textContent = isFav ? '❤️ In My Books' : '🤍 Save to My Books';
        favBtn.className = isFav ? 'btn-secondary saved' : 'btn-secondary';
        btn.disabled = false;
        $('#audiobook-progress-container').classList.add('hidden');
        $('#audiobook-progress-status').textContent = 'Starting...';
        $('#audiobook-progress-percent').textContent = '0%';
        $('#audiobook-progress-fill').style.width = '0%';
        
        // Check if it's already in Premiumize by searching the title (optimistic check)
        checkExistingAudiobook(details.title);
        
        btn.onclick = () => startAudiobookDownload(details.magnet_link);
        
        audiobookModal.classList.remove('hidden');
    } catch (e) {
        hideLoading();
        console.error(e);
        showError(e.message);
    }
}

async function checkExistingAudiobook(title) {
    try {
        // Search Premiumize for the exact title 
        // Torrents often have weird names, so we might not find it, which is fine
        const { folder, audioFiles } = await searchPremiumizeForAudiobook(title);
        
        if (folder || audioFiles.length > 0) {
            if (folder) {
                const btn = $('#audiobook-download-btn');
                btn.textContent = '▶ Play from Premiumize Cache';
                btn.onclick = () => loadAudiobookFolder(folder.id, currentAudiobookDetails);
                showToast('Found in Premiumize cache!');
            } else if (audioFiles.length > 0) {
                const btn = $('#audiobook-download-btn');
                btn.textContent = '▶ Play from Premiumize Cache';
                btn.onclick = () => processDirectAudioFiles(audioFiles, currentAudiobookDetails);
                showToast('Found in Premiumize cache!');
            }
        }
    } catch (e) {
        console.error("Cache check failed", e);
    }
}

async function searchPremiumizeForAudiobook(title) {
    try {
        // Extract the two longest unique significant words from the title for a more specific query
        const getLongestWords = (str) => {
            const words = str.split(/[^a-zA-Z0-9]/).filter(w => w.length > 3).sort((a, b) => b.length - a.length);
            return [...new Set(words)].slice(0, 2).join(' ');
        };
        const searchWord = getLongestWords(title) || title.split(' ')[0];
        const response = await fetch(`/api/premiumize/search?q=${encodeURIComponent(searchWord)}`);
        const data = await response.json();
        
        if (!data || !data.results || data.results.length === 0) {
            return { folder: null, audioFiles: [] };
        }
        
        const sanitize = str => str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
        const targetWords = sanitize(title).split(' ').filter(w => w.length > 2 && w !== 'audiobook');
        const wordsToMatch = targetWords.length > 0 ? targetWords : sanitize(title).split(' ');
        
        const isMatch = (name) => {
            const n = sanitize(name);
            const matchCount = wordsToMatch.filter(w => n.includes(w)).length;
            // Require at least 50% of significant words to match
            const required = Math.max(1, Math.ceil(wordsToMatch.length / 2));
            return matchCount >= required;
        };

        const matchingResults = data.results.filter(i => isMatch(i.name));
        const folder = matchingResults.find(i => i.type === 'folder');
        const audioExtensions = ['.mp3', '.m4b', '.m4a', '.flac', '.wav', '.ogg'];
        const audioFiles = matchingResults.filter(i => 
            i.type === 'file' && audioExtensions.some(ext => i.name.toLowerCase().endsWith(ext))
        );
        
        return { folder, audioFiles };
    } catch (e) {
        console.error("Premiumize search failed", e);
        return { folder: null, audioFiles: [] };
    }
}

function processDirectAudioFiles(audioFiles, details) {
    audioFiles.sort((a, b) => a.name.localeCompare(b.name));
    audiobookModal.classList.add('hidden');
    
    const mappedTracks = audioFiles.map((file, index) => {
        const streamUrl = file.stream_link || file.directlink || file.link;
        const stableId = `ab_${details.title}_${file.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
        
        return {
            id: stableId,
            isrc: `LINK:${btoa(streamUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`,
            name: file.name.replace(/\.[^/.]+$/, ""),
            artists: details.author || 'Unknown Author',
            album: details.title,
            album_art: details.cover_image || '/static/icon.svg',
            duration: '0:00',
            source: 'audiobook',
            track_number: index + 1
        };
    });
    
    const albumData = {
        id: `ab_${details.id}_direct`,
        name: details.title,
        artists: details.author || 'Audiobook',
        image: details.cover_image || '/static/icon.svg',
        is_playlist: false
    };
    
    // Auto-save to My Books and cache the tracks
    addAudiobookFavorite(details);
    const favIdx = state.audiobookFavorites.findIndex(b => 
        b.name === details.title || b.id === details.id
    );
    if (favIdx !== -1) {
        state.audiobookFavorites[favIdx].cachedTracks = mappedTracks;
        state.audiobookFavorites[favIdx].cachedAt = Date.now();
        if (details.description) {
            state.audiobookFavorites[favIdx].description = details.description;
        }
        saveAudiobookFavorites();
    }
    
    showDetailView(albumData, mappedTracks);
}

async function startAudiobookDownload(magnetLink) {
    const btn = $('#audiobook-download-btn');
    btn.disabled = true;
    btn.textContent = 'Starting Transfer...';
    $('#audiobook-progress-container').classList.remove('hidden');
    
    try {
        const response = await fetch('/api/premiumize/transfer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ magnet_link: magnetLink })
        });
        const data = await response.json();
        
        if (data.status === 'success') {
            pollAudiobookTransfer(data.id || data.transfer_id); // The id depends on the exact API response
        } else {
            throw new Error(data.message || 'Failed to start transfer');
        }
    } catch (e) {
        btn.disabled = false;
        btn.textContent = '☁️ Download to Premiumize';
        showError(e.message);
    }
}

async function pollAudiobookTransfer(transferId) {
    if (audiobookPollInterval) clearInterval(audiobookPollInterval);
    
    // Fallback if transferId is missing from create transfer response
    const fetchStatus = async () => {
        try {
            const res = await fetch(`/api/premiumize/transfer/${transferId || ''}`);
            const data = await res.json();
            
            let transfer = null;
            if (transferId && data.transfer && !Array.isArray(data.transfer)) {
                transfer = data.transfer;
            } else if (data.transfer && Array.isArray(data.transfer)) {
                // Find highest progress if we don't know the ID
                transfer = data.transfer.filter(t => t.name && (t.name.includes(currentAudiobookDetails.title.split(' ')[0]) || t.message !== 'finished')).pop();
            }
            
            if (!transfer) {
                // If transfer disappeared, it might be finished
                clearInterval(audiobookPollInterval);
                audiobookPollInterval = null;
                // Now try to find the folder it created
                autoFindFinishedFolder();
                return;
            }
            
            const progress = (transfer.progress || 0) * 100;
            const statusStr = transfer.message || transfer.status || 'Downloading';
            
            $('#audiobook-progress-percent').textContent = `${progress.toFixed(1)}%`;
            $('#audiobook-progress-fill').style.width = `${progress}%`;
            $('#audiobook-progress-status').textContent = statusStr;
            
            if (transfer.status === 'finished' || progress >= 100) {
                clearInterval(audiobookPollInterval);
                audiobookPollInterval = null;
                $('#audiobook-progress-status').textContent = 'Complete! Loading tracks...';
                $('#audiobook-download-btn').textContent = '▶ Play';
                
                // If we get the folder ID directly from the transfer object
                if (transfer.folder_id) {
                    loadAudiobookFolder(transfer.folder_id, currentAudiobookDetails);
                } else {
                    autoFindFinishedFolder();
                }
            }
            
        } catch (e) {
            console.error('Polling error', e);
        }
    };
    
    audiobookPollInterval = setInterval(fetchStatus, 3000);
    fetchStatus(); // immediate run
}

async function autoFindFinishedFolder() {
    try {
        const { folder, audioFiles } = await searchPremiumizeForAudiobook(currentAudiobookDetails.title);
        
        if (folder) {
            loadAudiobookFolder(folder.id, currentAudiobookDetails);
        } else if (audioFiles.length > 0) {
            processDirectAudioFiles(audioFiles, currentAudiobookDetails);
        } else {
            $('#audiobook-progress-status').textContent = 'Completed, but could not locate folder. Check your Premiumize web interface.';
            $('#audiobook-progress-percent').textContent = '';
            $('#audiobook-download-btn').disabled = false;
            $('#audiobook-download-btn').textContent = 'Open Premiumize';
            $('#audiobook-download-btn').onclick = () => window.open('https://www.premiumize.me/files', '_blank');
        }
    } catch (e) {
        console.error(e);
        showError('Could not locate downloaded folder');
    }
}

async function loadAudiobookFolder(folderId, audiobookDetails) {
    showLoading('Loading audiobook tracks from Premiumize...');
    try {
        const response = await fetch(`/api/premiumize/folder/${folderId}`);
        const data = await response.json();
        hideLoading();
        
        let audioFiles = data.audio_files || [];
        
        // If empty, maybe it's nested in a subfolder. Let's recursively check (max 1 deep for simplicity)
        if (audioFiles.length === 0 && data.folders && data.folders.length > 0) {
            const subFolderId = data.folders[0].id;
            const subRes = await fetch(`/api/premiumize/folder/${subFolderId}`);
            const subData = await subRes.json();
            audioFiles = subData.audio_files || [];
        }
        
        if (audioFiles.length === 0) {
            showError('No audio files found in the downloaded folder.');
            return;
        }
        
        // Close modal and map tracks for showDetailView
        audiobookModal.classList.add('hidden');
        
        const mappedTracks = audioFiles.map((file, index) => {
            // Use stream_link if available, fallback to directlink for actual media access
            const streamUrl = file.stream_link || file.directlink || file.link;
            // Use a STABLE ID based on filename + audiobook title (stream URLs expire and change)
            const stableId = `ab_${audiobookDetails.title}_${file.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
            return {
                id: stableId, 
                isrc: `LINK:${btoa(streamUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`, 
                name: file.name.replace(/\.[^/.]+$/, ""), // Remove extension
                artists: audiobookDetails.title,
            album: audiobookDetails.title,
            album_art: audiobookDetails.cover_image || '/static/icon.svg',
            duration: '0:00', // We don't have duration upfront
            source: 'audiobook', // Mark as audiobook so it uses the podcast resume logic!
            track_number: index + 1
        };
    });
        
        const albumData = {
            id: `ab_${folderId}`,
            name: audiobookDetails.title,
            artists: 'Audiobook',
            image: audiobookDetails.cover_image || '/static/icon.svg',
            is_playlist: false
        };
        
        showDetailView(albumData, mappedTracks);
        
        // Cache the mapped tracks into the audiobookFavorites entry
        // so subsequent plays from My Books don't need to re-fetch from Premiumize
        const favIdx = state.audiobookFavorites.findIndex(b => 
            b.name === audiobookDetails.title || b.id === audiobookDetails.id
        );
        if (favIdx !== -1) {
            state.audiobookFavorites[favIdx].cachedTracks = mappedTracks;
            state.audiobookFavorites[favIdx].cachedAt = Date.now();
            // Cache the description from AudiobookBay for the book info modal
            if (audiobookDetails.description) {
                state.audiobookFavorites[favIdx].description = audiobookDetails.description;
            }
            saveAudiobookFavorites();
            console.log('Cached audiobook tracks for:', audiobookDetails.title);
        }
        
    } catch (e) {
        hideLoading();
        console.error(e);
        showError('Failed to load audiobook folder');
    }
}

// ========== SPOTIFY OAUTH & UI ==========
(function initSpotifyOAuth() {
    const spotifyBtn = document.getElementById('spotify-connect-btn');
    if (!spotifyBtn) return;
    
    // Check URL for OAuth return status
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('spotify_connected') === 'true') {
        showToast('🟢 Connected to Spotify Account');
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
    } else if (urlParams.get('spotify_error')) {
        showToast('🔴 Spotify connection failed: ' + urlParams.get('spotify_error'));
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    // Check current status
    fetch('/api/spotify/status')
        .then(res => res.json())
        .then(data => {
            if (data.connected) {
                spotifyBtn.textContent = '🟢 Disconnect Spotify';
                spotifyBtn.classList.add('spotify-connected');
            } else {
                spotifyBtn.textContent = '🟢 Connect Spotify';
            }
        })
        .catch(console.error);
        
    // Handle click
    spotifyBtn.addEventListener('click', async () => {
        document.getElementById('search-more-menu')?.classList.add('hidden');
        
        if (spotifyBtn.classList.contains('spotify-connected')) {
            if (confirm('Disconnect from Spotify? This will re-enable 100-track limits on playlist imports.')) {
                try {
                    await fetch('/api/spotify/disconnect', { method: 'POST' });
                    spotifyBtn.textContent = '🟢 Connect Spotify';
                    spotifyBtn.classList.remove('spotify-connected');
                    showToast('Disconnected from Spotify');
                } catch (e) {
                    showToast('Error disconnecting');
                }
            }
        } else {
            // Redirect to login
            window.location.href = '/api/spotify/login';
        }
    });
})();
