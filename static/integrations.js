// ========== INTEGRATIONS MODULE ==========
// Media Session, Google Drive sync, Local files, AI Radio, Add-to-playlist modal,
// ListenBrainz/Last.fm scrobbling, Recommendations, Mini Player (Winamp PiP),
// AI Assistant, Spotify OAuth

import { state } from './state.js';
import { emit, on } from './event-bus.js';
import { showToast, escapeHtml, formatTime } from './utils.js';
import { $, $$, audioPlayer, audioPlayer2, domState, searchInput, resultsContainer, resultsSection, detailView, queueSection, volumeSlider } from './dom.js';
import { showLoading, hideLoading, showError, renderMoodSelector } from './ui.js';
import { audio, getActivePlayer } from './audio-engine.js';
import { enableSync, disableSync, discoverDevices } from './sync.js';
import { savePlaylists, createPlaylist, addToPlaylist, saveLibrary, saveHistory,
         savePodcastFavorites, saveAudiobookFavorites, savePodcastPlayed,
         savePodcastResumePositions, savePodcastHistory, saveAudiobookHistory,
         savePodcastTags, getMoodPreferences } from './data.js';

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
}

// Register action handlers at page load — they persist across playbacks (per web.dev spec)
if ('mediaSession' in navigator) {
    const actionHandlers = [
        ['play', async () => {
            if (audio.audioContext?.state === 'suspended') {
                await audio.audioContext.resume();
            }
            await getActivePlayer().play().catch(e => console.warn('MediaSession play failed:', e));
        }],
        ['pause', () => {
            state.isPlaying = false;
            getActivePlayer().pause();
        }],
        ['previoustrack', () => {
            emit('playPrevious');
        }],
        ['nexttrack', () => {
            emit('playNext');
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
            emit('updatePlayButton');
            navigator.mediaSession.playbackState = 'none';
        }]
    ];

    for (const [action, handler] of actionHandlers) {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
        } catch (error) {
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
        if (audio.audioContext?.state === 'suspended' && state.isPlaying) {
            audio.audioContext.resume();
        }
        // Clear stale crossfade guard that may have been frozen
        if (audio.crossfadeTimeout) {
            clearTimeout(audio.crossfadeTimeout);
            audio.crossfadeTimeout = null;
        }
        // If we should be playing but audio is paused, try to resume
        const player = getActivePlayer();
        if (state.isPlaying && player.paused && player.readyState >= 2) {
            player.play().catch(() => {});
        }
    }
});

// Recover from network drops in background
window.addEventListener('online', () => {
    const player = getActivePlayer();
    if (state.isPlaying && (player.paused || player.readyState < 3)) {
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
            }
        }
    } catch (e) {
    }
})();
const syncBtn = $('#sync-btn');

// Initialize Google API
// Initialize Google API
window.initGoogleApi = function() {
    return new Promise((resolve) => {
        if (typeof gapi === 'undefined') {
            resolve(false);
            return;
        }
        gapi.load('client', async () => {
            try {
                await gapi.client.init({
                    discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
                });
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
            syncData.moodHistory = state.moodHistory;
            syncData.moodPreferences = state.moodPreferences;
            syncData.watchedPlaylists = state.watchedPlaylists;
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

                // Restore mood data (optional keys — skip if absent)
                if (syncData.moodHistory) {
                    state.moodHistory = syncData.moodHistory;
                    localStorage.setItem('freedify_mood_history', JSON.stringify(state.moodHistory));
                }
                if (syncData.moodPreferences) {
                    state.moodPreferences = syncData.moodPreferences;
                    localStorage.setItem('freedify_mood_preferences', JSON.stringify(state.moodPreferences));
                }
                if (syncData.watchedPlaylists) {
                    state.watchedPlaylists = syncData.watchedPlaylists;
                    localStorage.setItem('freedify_watched', JSON.stringify(state.watchedPlaylists));
                }

                restoredCount = remotePlaylists.length;
                // If favorites view is active, refresh it
                if (state.searchType === 'favorites') emit('renderPlaylistsView');
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
                   emit('updateQueueUI');
                   emit('updatePlayerUI');
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
    // Close settings modal first so Drive modal isn't obscured
    document.getElementById('settings-modal')?.classList.add('hidden');
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

function initGoogleDriveSync() {
    // All event listeners are already bound above at module scope.
    // This function exists as a named init entry point for the main orchestrator.
}

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

}

function initManualUpload() {
    // const addLocalBtn = document.getElementById('add-local-btn'); // Replaced by Label
    const fileInput = document.getElementById('file-input');

    if (fileInput) {
        // No click listener needed for Label

        fileInput.addEventListener('change', (e) => {
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
        emit('updateQueueUI');
        if (!state.isPlaying && state.queue.length === processedCount) {
             emit('playTrack', 0); // Auto play if queue was empty
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
                    }
                    if (!key && (lowerName.includes('key') || lowerName === 'tkey')) {
                        key = val;
                    }
                }

                // Parse BPM as integer
                if (bpm) bpm = parseInt(String(bpm).replace(/\D/g, ''), 10) || null;


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

function initAIRadio() {
    // Toggle AI Radio
    if (aiRadioBtn) {
        aiRadioBtn.addEventListener('click', () => {
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

                showAIRadioStatus('AI Radio Active');
                showToast('AI Radio started! Will auto-add similar tracks.');
                checkAndAddTracks(); // Start immediately

                // Set up periodic check every 2 minutes (120 seconds)
                aiRadioInterval = setInterval(() => {
                    checkAndAddTracks();
                }, 120000);
            } else {
                hideAIRadioStatus();
                showToast('AI Radio stopped');
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

    // Mood selector is now rendered inside the Smart Playlist modal (initAIAssistant)

    // Hook into track end
    audioPlayer?.addEventListener('ended', () => {
        if (state.aiRadioActive) {
            setTimeout(checkAndAddTracks, 500);
        }
    });
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

// ========== TASTE PROFILE COLLECTOR ==========
// Samples tracks from library, playlists, and history to build a taste baseline
// for Gemini to personalize Smart Playlists and AI Radio from day one.
function collectTasteProfile() {
    const seen = new Set();
    const profile = [];

    function addTrack(name, artists) {
        if (!name || !artists) return;
        const key = `${artists} - ${name}`.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        profile.push(`${artists} - ${name}`);
    }

    // 1. Library (starred tracks) — up to 15
    if (state.library && state.library.length) {
        const libSample = state.library.slice(0, 15);
        libSample.forEach(t => addTrack(t.name, t.artists));
    }

    // 2. Playlists — up to 15 (round-robin across playlists)
    if (state.playlists && state.playlists.length) {
        let playlistCount = 0;
        const maxPerPlaylist = Math.max(2, Math.floor(15 / state.playlists.length));
        for (const pl of state.playlists) {
            if (playlistCount >= 15) break;
            const tracks = pl.tracks || [];
            for (let i = 0; i < Math.min(tracks.length, maxPerPlaylist); i++) {
                if (playlistCount >= 15) break;
                addTrack(tracks[i].name, tracks[i].artists);
                playlistCount++;
            }
        }
    }

    // 3. History (recently played) — up to 10
    if (state.history && state.history.length) {
        const histSample = state.history.slice(0, 10);
        histSample.forEach(t => addTrack(t.name, t.artists));
    }

    console.log(`[TasteProfile] library=${state.library?.length || 0}, playlists=${state.playlists?.length || 0}, history=${state.history?.length || 0} → ${profile.length} taste tracks`);
    return profile.length > 0 ? profile : undefined;
}

async function checkAndAddTracks() {
    if (!state.aiRadioActive || state.aiRadioFetching) return;

    const remainingTracks = state.queue.length - Math.max(0, state.currentIndex) - 1;

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

            // Build mood context
            let moodLiked = [];
            let moodDisliked = [];
            if (state.currentMood) {
                const prefs = getMoodPreferences(state.currentMood);
                moodLiked = prefs.liked.slice(0, 5).map(t => `${t.name} - ${t.artist}`);
                moodDisliked = prefs.disliked.slice(0, 5).map(t => `${t.name} - ${t.artist}`);
            }

            const requestBody = {
                seed_track: seed,
                mood: state.currentMood || (seed ? null : "popular music hits"),
                current_queue: queueTracks,
                count: 5,
                mood_liked: moodLiked.length ? moodLiked : undefined,
                mood_disliked: moodDisliked.length ? moodDisliked : undefined,
                taste_profile: collectTasteProfile(),
            };


            async function processAIRadioResponse(response) {
                if (response.ok) {
                    const data = await response.json();
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
                        emit('updateQueueUI');
                        showToast(`Added ${addedCount} tracks to queue`);
                    }
                }
            }

            try {
                const response = await fetch('/api/ai-radio/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody)
                });
                await processAIRadioResponse(response);
            } catch (err) {
                console.error('AI Radio with mood failed, retrying without mood:', err);
                showToast('Mood-aware recommendations failed. Falling back to standard mode.');
                // Retry without mood context
                const fallbackResponse = await fetch('/api/ai-radio/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ seed_track: seed, current_queue: queueTracks, count: 5 })
                });
                await processAIRadioResponse(fallbackResponse);
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

// Check when current track changes
on('trackStarted', () => {
    if (state.aiRadioActive) {
        setTimeout(checkAndAddTracks, 1000);
    }
});

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
            emit('performSearch', { query: state.lastSearchQuery, append: true });
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
        } catch (e) { console.error('Last.fm Scrobble error:', e); }
    }
}

// Check initial LB status
fetch('/api/listenbrainz/validate')
    .then(res => res.json())
    .then(data => {
        state.listenBrainzConfig = data;
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
            lfmBtn.textContent = `Last.fm: ${lfmUsername || 'Connected'}`;
            lfmBtn.classList.add('lastfm-connected');
        } else {
            lfmBtn.textContent = 'Connect Last.fm';
        }

        lfmBtn.addEventListener('click', () => {
            // Close both the More menu and settings modal
            document.getElementById('search-more-menu')?.classList.add('hidden');
            document.getElementById('settings-modal')?.classList.add('hidden');

            if (localStorage.getItem('lastfm_session_key')) {
                // Already connected — show disconnect option
                if (confirm(`Connected as ${localStorage.getItem('lastfm_username') || 'Unknown'}.\nDisconnect from Last.fm?`)) {
                    localStorage.removeItem('lastfm_session_key');
                    localStorage.removeItem('lastfm_username');
                    lfmBtn.textContent = 'Connect Last.fm';
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

    // Guard: only exchange a token once (tokens are single-use on Last.fm)
    let _lastfmExchangedToken = null;

    function safeExchangeLastFMToken(token) {
        if (!token || token === _lastfmExchangedToken) return;
        _lastfmExchangedToken = token;
        exchangeLastFMToken(token);
    }

    // Check for pending token (fallback from redirect)
    const pendingToken = localStorage.getItem('lastfm_pending_token');
    if (pendingToken) {
        localStorage.removeItem('lastfm_pending_token');
        safeExchangeLastFMToken(pendingToken);
    }

    // Listen for postMessage from auth popup
    window.addEventListener('message', (event) => {
        if (event.data?.type === 'lastfm-auth' && event.data.token) {
            safeExchangeLastFMToken(event.data.token);
        }
    });

    // Listen for BroadcastChannel (fallback when window.opener is null)
    try {
        const bc = new BroadcastChannel('freedify_lastfm');
        bc.onmessage = (event) => {
            if (event.data?.type === 'lastfm-auth' && event.data.token) {
                safeExchangeLastFMToken(event.data.token);
            }
        };
    } catch(e) {}

    // Check for pending token when window regains focus (fallback if both channels fail)
    window.addEventListener('focus', () => {
        const pt = localStorage.getItem('lastfm_pending_token');
        if (pt) {
            localStorage.removeItem('lastfm_pending_token');
            safeExchangeLastFMToken(pt);
        }
    });

    if (lfmSessionKey) {
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
                lfmBtn.textContent = `Last.fm: ${data.username}`;
                lfmBtn.classList.add('lastfm-connected');
            }

            showToast(`Connected to Last.fm as ${data.username}`);
        } else {
            showToast('Last.fm authorization failed');
        }
    } catch (e) {
        console.error('Last.fm token exchange error:', e);
        showToast('Last.fm connection error');
    }
}

// ========== RECOMMENDATIONS VIEW ==========

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

        // Show in detail view
        emit('showDetailView', { item: playlist, tracks: playlist.tracks || [] });
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

        // Show in detail view
        emit('showDetailView', { item: playlist, tracks: playlist.tracks || [] });
    } catch (e) {
        console.error('Failed to load LB playlist:', e);
        showError('Failed to load playlist');
    }
}

// ==================== WINAMP MINI PLAYER ====================
async function toggleMiniPlayer() {
    if (!('documentPictureInPicture' in window)) {
        showError('Mini Player not supported in this browser (Chrome/Edge 116+ required)');
        return;
    }

    if (domState.pipWindow) {
        domState.pipWindow.close();
        domState.pipWindow = null;
        return;
    }

    try {
        domState.pipWindow = await documentPictureInPicture.requestWindow({
            width: 320,
            height: 160,
        });

        // Copy Styles
        [...document.styleSheets].forEach((styleSheet) => {
            try {
                const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
                const style = document.createElement('style');
                style.textContent = cssRules;
                domState.pipWindow.document.head.appendChild(style);
            } catch (e) {
                // Ignore CORS errors for external sheets
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.type = styleSheet.type;
                link.media = styleSheet.media;
                link.href = styleSheet.href;
                domState.pipWindow.document.head.appendChild(link);
            }
        });

        // Render Winamp HTML
        updateMiniPlayerDOM();

        // Bind Controls
        const doc = domState.pipWindow.document;
        doc.getElementById('wa-prev').onclick = () => emit('playPrevious');
        doc.getElementById('wa-play').onclick = () => {
             const p = getActivePlayer();
             if (p.paused) p.play(); else p.pause();
             updateMiniPlayer(); // Immediate update
        };
        doc.getElementById('wa-pause').onclick = () => getActivePlayer().pause();
        doc.getElementById('wa-next').onclick = () => emit('playNext');
        doc.getElementById('wa-vol').oninput = (e) => {
            const val = e.target.value / 100;
            emit('updateVolume', val); // Syncs main slider too
        };

        // Force initial update
        updateMiniPlayer();

        // Handle Close
        domState.pipWindow.addEventListener('pagehide', () => {
            domState.pipWindow = null;
        });

    } catch (err) {
        console.error('Failed to open Mini Player:', err);
    }
}

function updateMiniPlayerDOM() {
    if (!domState.pipWindow) return;
    const doc = domState.pipWindow.document;

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
    if (!domState.pipWindow) return;
    const doc = domState.pipWindow.document;
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
const aiDurationSelect = document.getElementById('ai-duration-select');

// Open/Close Modal
function openAIModal() {
    if (aiModal) {
        aiModal.classList.remove('hidden');
        // Refresh mood selector with latest stats each time modal opens
        const moodContainer = document.getElementById('mood-selector-container');
        if (moodContainer) renderMoodSelector(moodContainer);
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

function initAIAssistant() {
    // Event listeners
    aiMenuBtn?.addEventListener('click', openAIModal);
    aiModalClose?.addEventListener('click', closeAIModal);
    aiModalOverlay?.addEventListener('click', closeAIModal);

    // Render mood selector inside the Smart Playlist modal
    const moodContainer = document.getElementById('mood-selector-container');
    if (moodContainer) {
        renderMoodSelector(moodContainer);
    }

    // Playlist Generator
    aiPlaylistGenBtn?.addEventListener('click', async () => {
        const description = aiPlaylistInput?.value?.trim();
        if (!description) return;

        const duration = parseInt(aiDurationSelect?.value) || 60;

        aiPlaylistGenBtn.disabled = true;
        aiPlaylistResults.innerHTML = '<div class="ai-loading">Generating playlist</div>';

        try {
            const res = await fetch('/api/ai/generate-playlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description,
                    duration_mins: duration,
                    mood: state.currentMood || undefined,
                    mood_liked: (() => {
                        if (!state.currentMood) return undefined;
                        const prefs = getMoodPreferences(state.currentMood);
                        const liked = prefs.liked.slice(0, 5).map(t => `${t.name} - ${t.artist}`);
                        return liked.length ? liked : undefined;
                    })(),
                    mood_disliked: (() => {
                        if (!state.currentMood) return undefined;
                        const prefs = getMoodPreferences(state.currentMood);
                        const disliked = prefs.disliked.slice(0, 5).map(t => `${t.name} - ${t.artist}`);
                        return disliked.length ? disliked : undefined;
                    })(),
                    taste_profile: collectTasteProfile(),
                })
            });
            const data = await res.json();

            if (data.tracks && data.tracks.length > 0) {
                let html = `
                    <div class="ai-results-header">
                        <span>${data.playlist_name || 'Generated Playlist'}</span>
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

                html += '<button class="ai-add-all-btn" id="ai-add-all">Add All to Queue</button>';

                aiPlaylistResults.innerHTML = html;

                // Click handler for individual tracks
                aiPlaylistResults.querySelectorAll('.ai-track-item').forEach(item => {
                    item.addEventListener('click', async () => {
                        const searchQuery = `${item.dataset.artist} ${item.dataset.title}`;
                        closeAIModal();
                        searchInput.value = searchQuery;
                        emit('performSearch', searchQuery);
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
                        emit('addToQueue', firstResult);
                        if (shouldAutoPlay) {
                            emit('playTrack', firstResult);
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
                                emit('addToQueue', result);
                                addedCount++;

                                // Fallback: If first track failed to play/find, play the first valid one we found here
                                if (shouldAutoPlay && !hasStartedPlaying) {
                                    emit('playTrack', result);
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
}

// ========== SPOTIFY OAUTH & UI ==========
function initSpotifyOAuth() {
    const spotifyBtn = document.getElementById('spotify-connect-btn');
    if (!spotifyBtn) return;

    // Check URL for OAuth return status
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('spotify_connected') === 'true') {
        showToast('Connected to Spotify Account');
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
    } else if (urlParams.get('spotify_error')) {
        showToast('Spotify connection failed: ' + urlParams.get('spotify_error'));
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    // Check current status
    fetch('/api/spotify/status')
        .then(res => res.json())
        .then(data => {
            if (data.connected) {
                spotifyBtn.textContent = 'Disconnect Spotify';
                spotifyBtn.classList.add('spotify-connected');
            } else {
                spotifyBtn.textContent = 'Connect Spotify';
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
                    spotifyBtn.textContent = 'Connect Spotify';
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
}

// ========== CROSS-DEVICE SYNC UI ==========

let syncModalEl = null;

export function initSyncUI() {
    // Create sync modal (same pattern as Smart Playlist modal)
    syncModalEl = document.createElement('div');
    syncModalEl.id = 'sync-modal';
    syncModalEl.className = 'ai-modal hidden';
    syncModalEl.innerHTML = `
        <div class="ai-modal-overlay"></div>
        <div class="ai-modal-content">
            <div class="ai-modal-header">
                <h2>🔗 Sync Devices</h2>
                <button class="ai-modal-close" id="sync-modal-close" title="Close">×</button>
            </div>
            <div class="sync-panel">
                <div class="sync-header">
                    <span>Enable Sync</span>
                    <label class="sync-switch">
                        <input type="checkbox" id="sync-toggle" ${state.syncEnabled ? 'checked' : ''} />
                        <span class="sync-switch-slider"></span>
                    </label>
                </div>
                <div class="sync-role-section">
                    <label class="sync-role-label">This device is:</label>
                    <div class="sync-role-buttons">
                        <button class="sync-role-btn ${state.syncRole === 'player' ? 'active' : ''}" data-role="player">🔊 Speaker</button>
                        <button class="sync-role-btn ${state.syncRole === 'remote' ? 'active' : ''}" data-role="remote">📱 Remote</button>
                    </div>
                    <p class="sync-role-hint" id="sync-role-hint">${state.syncRole === 'remote' ? 'Audio plays on the other device. This device controls playback.' : 'Audio plays here. Other devices act as remotes.'}</p>
                </div>
                <div class="sync-devices-list" id="sync-devices-list">
                    <p class="sync-hint">Toggle on to discover devices on your network</p>
                </div>
                <div class="sync-manual">
                    <input type="text" id="sync-manual-ip" placeholder="Enter IP (e.g., 192.168.1.100:8000)"
                        value="${escapeHtml(localStorage.getItem('freedify_sync_last_ip') || '')}" />
                    <button id="sync-manual-connect">Connect</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(syncModalEl);

    // Open from search-more-menu button
    const syncMenuBtn = document.getElementById('sync-menu-btn');
    syncMenuBtn?.addEventListener('click', () => {
        syncModalEl.classList.remove('hidden');
        document.getElementById('search-more-menu')?.classList.add('hidden');
    });

    // Close handlers
    syncModalEl.querySelector('#sync-modal-close').addEventListener('click', () => {
        syncModalEl.classList.add('hidden');
    });
    syncModalEl.querySelector('.ai-modal-overlay').addEventListener('click', () => {
        syncModalEl.classList.add('hidden');
    });

    // Toggle handler
    const toggle = syncModalEl.querySelector('#sync-toggle');
    toggle.addEventListener('change', async () => {
        if (toggle.checked) {
            const devices = await discoverDevices();
            renderDeviceList(devices);
            if (devices.length > 0) {
                enableSync(`http://${devices[0].ip}:${devices[0].port}`);
            } else {
                const lastIp = localStorage.getItem('freedify_sync_last_ip');
                if (lastIp) {
                    enableSync(lastIp);
                } else {
                    showToast('No devices found. Enter IP manually.');
                }
            }
        } else {
            disableSync();
        }
    });

    // Manual connect handler
    syncModalEl.querySelector('#sync-manual-connect').addEventListener('click', () => {
        const ip = syncModalEl.querySelector('#sync-manual-ip').value.trim();
        if (!ip) return;
        const url = ip.startsWith('http') ? ip : `http://${ip}`;
        enableSync(url);
        syncModalEl.classList.add('hidden');
    });

    // Device role selector
    syncModalEl.querySelectorAll('.sync-role-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const role = btn.dataset.role;
            state.syncRole = role;
            localStorage.setItem('freedify_sync_role', JSON.stringify(role));

            // Update button active states
            syncModalEl.querySelectorAll('.sync-role-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update hint text
            const hint = syncModalEl.querySelector('#sync-role-hint');
            if (hint) {
                hint.textContent = role === 'remote'
                    ? 'Audio plays on the other device. This device controls playback.'
                    : 'Audio plays here. Other devices act as remotes.';
            }

            // Apply role immediately
            const player = document.getElementById('audio-player');
            const player2 = document.getElementById('audio-player-2');
            if (role === 'remote') {
                if (player) player.muted = true;
                if (player2) player2.muted = true;
                showToast('Remote mode — audio plays on the other device');
            } else {
                if (player) player.muted = state.muted;
                if (player2) player2.muted = state.muted;
                showToast('Speaker mode — audio plays on this device');
            }

            // Refresh the indicator label
            if (state.syncEnabled) updateSyncIndicator('connected');
        });
    });

    // Apply saved role on init (if remote, mute audio)
    if (state.syncRole === 'remote' && state.syncEnabled) {
        const player = document.getElementById('audio-player');
        const player2 = document.getElementById('audio-player-2');
        if (player) player.muted = true;
        if (player2) player2.muted = true;
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && syncModalEl && !syncModalEl.classList.contains('hidden')) {
            syncModalEl.classList.add('hidden');
        }
    });

    // Listen for status changes
    on('syncStatusChanged', (status) => {
        updateSyncIndicator(status);
    });
}

function renderDeviceList(devices) {
    const list = document.getElementById('sync-devices-list');
    if (!list) return;
    if (devices.length === 0) {
        list.innerHTML = '<p class="sync-hint">No devices found. Try manual IP.</p>';
        return;
    }
    // escapeHtml on mDNS-provided values to prevent injection (CLAUDE.md rule)
    list.innerHTML = devices.map(d => `
        <div class="sync-device" onclick="window.connectSyncDevice('http://${escapeHtml(d.ip)}:${escapeHtml(String(d.port))}')">
            <span class="sync-device-name">${escapeHtml(d.name)}</span>
            <span class="sync-device-ip">${escapeHtml(d.ip)}:${escapeHtml(String(d.port))}</span>
        </div>
    `).join('');
}

function updateSyncIndicator(status) {
    const indicator = document.getElementById('sync-indicator');
    if (!indicator) return;

    if (status === 'connected') {
        const roleLabel = state.syncRole === 'remote' ? 'Remote' : 'Playing';
        indicator.textContent = `🔗 ${roleLabel}`;
        indicator.classList.remove('hidden');
        indicator.title = `Synced — ${roleLabel}`;
    } else if (status === 'connecting' || (status === 'disconnected' && state.syncEnabled)) {
        // Keep visible during reconnect to avoid layout jitter
        indicator.textContent = '🔗 …';
        indicator.classList.remove('hidden');
        indicator.title = 'Reconnecting...';
    } else {
        indicator.classList.add('hidden');
    }
}

// ========== FULL DATA EXPORT / IMPORT ==========

function exportAllData() {
    try {
        const backup = {
            _meta: {
                app: 'Freedify',
                version: 1,
                exportedAt: new Date().toISOString()
            },
            // Core data (mirrors Drive sync)
            playlists: state.playlists,
            library: state.library,
            history: state.history,
            queue: state.queue,
            currentIndex: state.currentIndex,
            volume: state.volume,
            // Podcast & audiobook data
            podcastFavorites: state.podcastFavorites,
            audiobookFavorites: state.audiobookFavorites,
            podcastPlayedEpisodes: state.podcastPlayedEpisodes,
            podcastResumePositions: state.podcastResumePositions,
            podcastHistory: state.podcastHistory,
            audiobookHistory: state.audiobookHistory,
            podcastTags: state.podcastTags,
            // Mood data
            moodHistory: state.moodHistory,
            moodPreferences: state.moodPreferences,
            // Watched playlists
            watchedPlaylists: state.watchedPlaylists,
            // Settings
            settings: {
                theme: localStorage.getItem('freedify_theme') || '',
                hiRes: localStorage.getItem('freedify_hires') || 'false',
                hiResQuality: localStorage.getItem('freedify_hires_quality') || '7',
                crossfade: localStorage.getItem('freedify_crossfade') || 'false',
                lastfmUsername: localStorage.getItem('freedify_lastfm_user') || '',
                eqSettings: localStorage.getItem('freedify_eq') || '',
                googleClientId: localStorage.getItem('freedify_google_client_id') || ''
            }
        };

        const json = JSON.stringify(backup, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const date = new Date().toISOString().slice(0, 10);
        const a = document.createElement('a');
        a.href = url;
        a.download = `freedify_backup_${date}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        const counts = [
            `${state.playlists.length} playlists`,
            `${state.library.length} library tracks`,
            `${state.history.length} history items`
        ].join(', ');
        showToast(`Exported: ${counts}`);
    } catch (e) {
        console.error('Export error:', e);
        showToast('Failed to export data');
    }
}

async function importAllData(file) {
    try {
        const text = await file.text();
        const data = JSON.parse(text);

        // Basic validation
        if (!data || typeof data !== 'object') {
            showToast('Invalid backup file');
            return;
        }

        // Check for at least one expected key
        const expectedKeys = ['playlists', 'library', 'history', 'podcastFavorites', 'audiobookFavorites'];
        const hasAny = expectedKeys.some(k => data[k] !== undefined);
        if (!hasAny) {
            showToast('This file doesn\'t look like a Freedify backup');
            return;
        }

        if (!confirm(`Import Freedify backup from ${data._meta?.exportedAt || 'unknown date'}?\n\nThis will REPLACE all your current data.`)) {
            return;
        }

        showLoading('Importing data...');

        // Restore core data
        if (data.playlists) {
            state.playlists = data.playlists;
            savePlaylists();
        }
        if (data.library) {
            state.library = data.library;
            saveLibrary();
        }
        if (data.history) {
            state.history = data.history;
            saveHistory();
        }
        if (data.queue) {
            state.queue = data.queue;
            localStorage.setItem('freedify_queue', JSON.stringify(data.queue));
        }
        if (data.currentIndex !== undefined) {
            state.currentIndex = data.currentIndex;
        }
        if (data.volume !== undefined) {
            state.volume = data.volume;
        }

        // Podcast & audiobook data
        if (data.podcastFavorites) {
            state.podcastFavorites = data.podcastFavorites;
            savePodcastFavorites();
        }
        if (data.audiobookFavorites) {
            state.audiobookFavorites = data.audiobookFavorites;
            saveAudiobookFavorites();
        }
        if (data.podcastPlayedEpisodes) {
            state.podcastPlayedEpisodes = data.podcastPlayedEpisodes;
            savePodcastPlayed();
        }
        if (data.podcastResumePositions) {
            state.podcastResumePositions = data.podcastResumePositions;
            savePodcastResumePositions();
        }
        if (data.podcastHistory) {
            state.podcastHistory = data.podcastHistory;
            savePodcastHistory();
        }
        if (data.audiobookHistory) {
            state.audiobookHistory = data.audiobookHistory;
            saveAudiobookHistory();
        }
        if (data.podcastTags) {
            state.podcastTags = data.podcastTags;
            savePodcastTags();
        }

        // Mood data
        if (data.moodHistory) {
            state.moodHistory = data.moodHistory;
            localStorage.setItem('freedify_mood_history', JSON.stringify(data.moodHistory));
        }
        if (data.moodPreferences) {
            state.moodPreferences = data.moodPreferences;
            localStorage.setItem('freedify_mood_preferences', JSON.stringify(data.moodPreferences));
        }

        // Watched playlists
        if (data.watchedPlaylists) {
            state.watchedPlaylists = data.watchedPlaylists;
            localStorage.setItem('freedify_watched', JSON.stringify(data.watchedPlaylists));
        }

        // Settings
        if (data.settings) {
            const s = data.settings;
            if (s.theme) localStorage.setItem('freedify_theme', s.theme);
            if (s.hiRes) localStorage.setItem('freedify_hires', s.hiRes);
            if (s.hiResQuality) localStorage.setItem('freedify_hires_quality', s.hiResQuality);
            if (s.crossfade) localStorage.setItem('freedify_crossfade', s.crossfade);
            if (s.lastfmUsername) localStorage.setItem('freedify_lastfm_user', s.lastfmUsername);
            if (s.eqSettings) localStorage.setItem('freedify_eq', s.eqSettings);
            if (s.googleClientId) localStorage.setItem('freedify_google_client_id', s.googleClientId);
        }

        hideLoading();
        showToast('Data imported successfully! Reloading...');
        setTimeout(() => location.reload(), 1500);
    } catch (e) {
        hideLoading();
        console.error('Import error:', e);
        showToast('Failed to import — invalid or corrupted file');
    }
}

function initDataExportImport() {
    const exportBtn = $('#export-all-data-btn');
    const importBtn = $('#import-all-data-btn');
    const importInput = $('#import-all-data-input');

    exportBtn?.addEventListener('click', () => {
        exportAllData();
        // Close the More menu
        $('#search-more-menu')?.classList.add('hidden');
    });

    importBtn?.addEventListener('click', () => {
        importInput?.click();
        $('#search-more-menu')?.classList.add('hidden');
    });

    importInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) importAllData(file);
        e.target.value = ''; // Reset
    });
}

// ========== EXPORTS ==========
export {
    updateMediaSession,
    submitNowPlaying,
    submitScrobble,
    updateMiniPlayer,
    toggleMiniPlayer,
    openAddToPlaylistModal,
    renderRecommendations,
    initLocalFiles,
    initGoogleDriveSync,
    initSpotifyOAuth,
    initAIRadio,
    initAIAssistant,
    checkAndAddTracks,
    initDataExportImport
};
