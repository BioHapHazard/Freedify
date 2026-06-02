/**
 * Freedify Cloud Sync
 * Automatic sync of all user state to Supabase via server API.
 * 
 * Usage:
 *   import { markDirty, pullAll, initCloudSync, cloudLogin, cloudSignup, cloudLogout } from './cloud-sync.js';
 *   markDirty('library');  // after any localStorage write
 */

import { state, safeLoad, normalizeHiResQuality } from './state.js';
import { emit } from './event-bus.js';

// ========== SYNC MAP ==========
// Maps data_key → { stateKey (dot path into state.*), lsKey (localStorage key) }
const SYNC_MAP = {
    library:             { stateKey: 'library',               lsKey: 'freedify_library' },
    playlists:           { stateKey: 'playlists',              lsKey: 'freedify_playlists' },
    history:             { stateKey: 'history',                lsKey: 'freedify_history' },
    resume_positions:    { stateKey: 'podcastResumePositions',  lsKey: 'freedify_podcast_resume' },
    podcast_favorites:   { stateKey: 'podcastFavorites',        lsKey: 'freedify_podcasts' },
    audiobook_favorites: { stateKey: 'audiobookFavorites',      lsKey: 'freedify_audiobooks' },
    podcast_history:     { stateKey: 'podcastHistory',          lsKey: 'freedify_podcast_history' },
    audiobook_history:   { stateKey: 'audiobookHistory',        lsKey: 'freedify_audiobook_history' },
    podcast_played:      { stateKey: 'podcastPlayedEpisodes',   lsKey: 'freedify_podcast_played' },
    watched_playlists:   { stateKey: 'watchedPlaylists',        lsKey: 'freedify_watched' },
    queue_state:         { stateKey: null,                      lsKey: null },
    settings:            { stateKey: null,                      lsKey: null },
};

let _token = localStorage.getItem('freedify_cloud_token');
let _userId = localStorage.getItem('freedify_cloud_user_id');
let _email = localStorage.getItem('freedify_cloud_email') || _decodeEmailFromToken(_token);

function _decodeEmailFromToken(token) {
    if (!token) return null;
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return payload.email || null;
    } catch { return null; }
}

// ========== PUSH (debounced, per-key) ==========
const _pendingPushes = new Set();
let _pushDebounce = null;

/**
 * Mark a sync key as dirty. Will be pushed to the server after a 2s debounce.
 * Safe to call when not logged in (no-op).
 */
export function markDirty(key) {
    if (!_token) return;
    _pendingPushes.add(key);
    clearTimeout(_pushDebounce);
    _pushDebounce = setTimeout(flushPushes, 2000);
}

async function flushPushes() {
    const keys = [..._pendingPushes];
    _pendingPushes.clear();
    if (!_token) return;

    _updateUI('syncing');

    for (const key of keys) {
        const data = _getStateForKey(key);
        try {
            await fetch(`/api/cloud/sync/${key}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${_token}`
                },
                body: JSON.stringify({ data })
            });
        } catch (e) {
            console.warn(`Cloud sync push failed for ${key}:`, e);
        }
    }

    _updateUI('synced');
}

// ========== PULL (on login / page load) ==========

/**
 * Pull ALL sync data from the server and apply to local state + localStorage.
 */
export async function pullAll() {
    if (!_token) return;
    _updateUI('syncing');
    try {
        const resp = await fetch('/api/cloud/sync/all', {
            headers: { 'Authorization': `Bearer ${_token}` }
        });
        if (!resp.ok) {
            if (resp.status === 401) {
                // Token expired — log out
                cloudLogout();
                return;
            }
            throw new Error(`Pull failed: ${resp.status}`);
        }
        const data = await resp.json();
        for (const [key, value] of Object.entries(data)) {
            _applyStateForKey(key, value);
        }
        _updateUI('synced');
    } catch (e) {
        console.warn('Cloud sync pull failed:', e);
        _updateUI('error');
    }
}

// ========== AUTH ==========

export async function cloudLogin(email, password) {
    try {
        const resp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || 'Login failed');
        }
        const result = await resp.json();
        _token = result.access_token;
        _userId = result.user_id;
        _email = email;
        localStorage.setItem('freedify_cloud_token', _token);
        localStorage.setItem('freedify_cloud_user_id', _userId);
        localStorage.setItem('freedify_cloud_email', _email);
        _updateUI('syncing');
        return result;
    } catch (e) {
        _updateUI('error');
        throw e;
    }
}

export async function cloudSignup(email, password) {
    try {
        const resp = await fetch('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || 'Signup failed');
        }
        const result = await resp.json();
        if (result.access_token) {
            _token = result.access_token;
            _userId = result.user_id;
            _email = email;
            localStorage.setItem('freedify_cloud_token', _token);
            localStorage.setItem('freedify_cloud_user_id', _userId);
            localStorage.setItem('freedify_cloud_email', _email);
            _updateUI('syncing');
        }
        return result;
    } catch (e) {
        _updateUI('error');
        throw e;
    }
}

export function getCloudEmail() {
    return _email;
}

export function cloudLogout() {
    _token = null;
    _userId = null;
    _email = null;
    localStorage.removeItem('freedify_cloud_token');
    localStorage.removeItem('freedify_cloud_user_id');
    localStorage.removeItem('freedify_cloud_email');
    _pendingPushes.clear();
    clearTimeout(_pushDebounce);
    _updateUI('logged_out');
}

export function isCloudLoggedIn() {
    return !!_token;
}

export function getCloudUserId() {
    return _userId;
}

// ========== PUSH ALL (one-time migration on first login) ==========

/**
 * Push ALL current localStorage data to the cloud. Used after first signup.
 */
export async function pushAll() {
    if (!_token) return;
    _updateUI('syncing');
    for (const key of Object.keys(SYNC_MAP)) {
        const data = _getStateForKey(key);
        // Skip empty data
        if (data === null || data === undefined) continue;
        if (Array.isArray(data) && data.length === 0) continue;
        if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0) continue;
        try {
            await fetch(`/api/cloud/sync/${key}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${_token}`
                },
                body: JSON.stringify({ data })
            });
        } catch (e) {
            console.warn(`Cloud sync push-all failed for ${key}:`, e);
        }
    }
    _updateUI('synced');
}

// ========== HELPERS ==========

function _getStateForKey(key) {
    const mapping = SYNC_MAP[key];
    if (!mapping) return null;

    // Special: resume_positions — convert seconds → milliseconds for cloud storage
    if (key === 'resume_positions') {
        const positions = state.podcastResumePositions || {};
        const converted = {};
        for (const [id, val] of Object.entries(positions)) {
            if (typeof val === 'number') {
                // Old format: plain seconds
                converted[id] = { positionMs: Math.round(val * 1000), durationMs: 0, updatedAt: Date.now() };
            } else if (val && typeof val === 'object') {
                // Already in object format
                converted[id] = {
                    positionMs: val.positionMs || Math.round((val.position || val) * 1000),
                    durationMs: val.durationMs || Math.round((val.duration || 0) * 1000),
                    updatedAt: val.updatedAt || Date.now()
                };
            }
        }
        return converted;
    }

    // Special: settings
    if (key === 'settings') {
        return {
            hiRes: state.hiResMode,
            hiResQuality: state.hiResQuality,
            volume: state.volume,
            playbackSpeed: state.playbackSpeed,
        };
    }

    // Special: queue_state
    if (key === 'queue_state') {
        return {
            queue: state.queue,
            currentIndex: state.currentIndex,
        };
    }

    if (mapping.stateKey) {
        return state[mapping.stateKey];
    }
    return null;
}

function _applyStateForKey(key, value) {
    const mapping = SYNC_MAP[key];
    if (!mapping || value === null || value === undefined) return;

    // Special: resume_positions — convert milliseconds → seconds for web app
    if (key === 'resume_positions') {
        const converted = {};
        for (const [id, val] of Object.entries(value)) {
            if (val && typeof val === 'object' && val.positionMs !== undefined) {
                converted[id] = Math.round(val.positionMs / 1000);
            } else if (typeof val === 'number') {
                converted[id] = val;
            }
        }
        state.podcastResumePositions = converted;
        localStorage.setItem('freedify_podcast_resume', JSON.stringify(converted));
        return;
    }

    // Special: settings
    if (key === 'settings') {
        if (value.hiRes !== undefined) {
            state.hiResMode = value.hiRes;
            localStorage.setItem('freedify_hires', String(value.hiRes));
        }
        if (value.hiResQuality) {
            // Normalize old quality codes ('6'/'5') pulled from other devices
            state.hiResQuality = normalizeHiResQuality(value.hiResQuality);
            localStorage.setItem('freedify_hires_quality', state.hiResQuality);
        }
        if (value.volume !== undefined) {
            state.volume = value.volume;
            localStorage.setItem('freedify_volume', String(value.volume));
        }
        if (value.playbackSpeed !== undefined) {
            state.playbackSpeed = value.playbackSpeed;
        }
        return;
    }

    // Special: queue_state
    if (key === 'queue_state') {
        if (value.queue && Array.isArray(value.queue)) {
            state.queue = value.queue;
            state.currentIndex = value.currentIndex || 0;
            localStorage.setItem('freedify_queue', JSON.stringify({
                queue: value.queue,
                currentIndex: value.currentIndex || 0
            }));
        }
        return;
    }

    if (mapping.stateKey && mapping.lsKey) {
        state[mapping.stateKey] = value;
        localStorage.setItem(mapping.lsKey, JSON.stringify(value));
    }
}

// ========== UI STATUS ==========

function _updateUI(status) {
    emit('cloudSyncStatus', status);
}

// ========== INIT ==========

export function initCloudSync() {
    // If we have a saved token, pull on startup
    if (_token) {
        _updateUI('syncing');
        // Delay pull slightly so UI renders first
        setTimeout(() => pullAll(), 500);
    } else {
        _updateUI('logged_out');
    }
}
