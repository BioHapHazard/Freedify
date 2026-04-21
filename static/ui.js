/**
 * Freedify UI Module
 * Loading/error overlays, empty state/dashboard, theme picker, HiFi mode
 */

import { state } from './state.js';
import { escapeHtml, showToast } from './utils.js';
import { emit, on } from './event-bus.js';
import { getMoodStatsForWeek } from './data.js';
import {
    $, $$, loadingOverlay, loadingText, errorMessage, errorText,
    errorRetry, resultsContainer, searchInput,
} from './dom.js';

// ========== LOADING / ERROR ==========
export function showLoading(text) {
    loadingText.textContent = text || 'Loading...';
    loadingOverlay.classList.remove('hidden');
    errorMessage.classList.add('hidden');
}

export function hideLoading() {
    loadingOverlay.classList.add('hidden');
}

export function showError(message) {
    hideLoading();
    errorText.textContent = message;
    errorMessage.classList.remove('hidden');
}

errorRetry.addEventListener('click', () => {
    errorMessage.classList.add('hidden');
    const query = searchInput.value.trim();
    if (query) emit('performSearch', query);
});

// ========== DASHBOARD / EMPTY STATE ==========
export function showEmptyState() {
    const hasHistory = state.history && state.history.length > 0;
    const hasPlaylists = state.playlists && state.playlists.length > 0;
    const hasLibrary = state.library && state.library.length > 0;

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

    let html = '<div class="dashboard">';

    // Jump Back In
    if (hasHistory) {
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
                            <div class="dashboard-card" data-track-id="${escapeHtml(track.id)}" onclick="openJumpBackInAlbum('${escapeHtml(track.id)}')">
                                <img src="${track.album_art || '/static/icon.svg'}" alt="${escapeHtml(track.album || track.name)}" loading="lazy">
                                <div class="dashboard-card-info">
                                    <p class="dashboard-card-title">${escapeHtml(track.artists)}</p>
                                    <p class="dashboard-card-subtitle">${escapeHtml(track.album || track.name)}</p>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </section>
            `;
        }
    }

    // Recent Artists
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

    // Library
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

    // Playlists
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

// ========== DASHBOARD HELPERS ==========
import { getEpisodePosition } from './data.js';

export function playHistoryTrack(trackId) {
    const track = state.history.find(t => t.id === trackId) || state.library.find(t => t.id === trackId);
    if (track) {
        state.queue = [track];
        state.currentIndex = 0;

        if (track.source === 'podcast' || track.source === 'audiobook') {
            const savedPos = getEpisodePosition(track.id);
            if (savedPos > 10) {
                const resumeMin = Math.floor(savedPos / 60);
                const resumeSec = savedPos % 60;
                showToast(`Resuming from ${resumeMin}:${String(resumeSec).padStart(2, '0')}`);
                track._resumeAt = savedPos;
            }
        }

        emit('loadTrack', track);
    }
}

export async function openJumpBackInAlbum(trackId) {
    const track = state.history.find(t => t.id === trackId);
    if (!track) { playHistoryTrack(trackId); return; }

    // Podcasts & audiobooks don't have albums — play directly with resume
    if (track.source === 'podcast' || track.source === 'audiobook') {
        playHistoryTrack(trackId);
        return;
    }

    if (track.album_id) {
        window.openAlbum(track.album_id);
        return;
    }

    // No stored album_id — search for the album by name + artist
    const query = (track.album || track.name) + ' ' + track.artists;
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=album`);
        const data = await res.json();
        if (data.results && data.results.length > 0 && data.results[0].id) {
            window.openAlbum(data.results[0].id);
            return;
        }
    } catch (e) {}

    // Album search failed — fall back to playing the track
    playHistoryTrack(trackId);
}

export function searchArtist(artistName) {
    searchInput.value = artistName;
    state.searchType = 'artist';
    emit('performSearch', artistName);
}

export function openPlaylistById(playlistId) {
    const playlist = state.playlists.find(p => p.id === playlistId);
    if (playlist) {
        emit('showPlaylistDetail', playlist);
    }
}

export function showLibraryView() {
    const libraryPlaylist = {
        id: '__library__',
        name: '⭐ Your Library',
        tracks: state.library,
        is_user_playlist: true
    };
    emit('showPlaylistDetail', libraryPlaylist);
}

// ========== SETTINGS MODAL ==========
const settingsBtn = $('#settings-btn');
const settingsModal = $('#settings-modal');
const settingsClose = $('#settings-close');

export function openSettingsModal() {
    settingsModal?.classList.remove('hidden');
}

export function closeSettingsModal() {
    settingsModal?.classList.add('hidden');
}

settingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettingsModal();
});

settingsClose?.addEventListener('click', closeSettingsModal);

// Close on backdrop click
settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
});

// Close on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsModal?.classList.contains('hidden')) {
        closeSettingsModal();
    }
});

// ========== THEME PICKER (inside Settings Modal) ==========
const themePicker = $('#theme-picker');
const themeOptions = $$('.theme-option');

// Source of truth for available theme class names (must stay in sync with index.html + styles.css)
const THEME_CLASSES = Array.from(themeOptions)
    .map(o => o.dataset.theme)
    .filter(Boolean);

function clearThemeClasses() {
    // Remove any previously-applied theme-* class (future-proof, won't break if new themes added)
    const toRemove = Array.from(document.body.classList).filter(c => c.startsWith('theme-'));
    toRemove.forEach(c => document.body.classList.remove(c));
}

function syncMetaThemeColor() {
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (!metaThemeColor) return;
    // Defer one frame so CSS variables are re-resolved against the new theme class
    requestAnimationFrame(() => {
        const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        if (accentColor) metaThemeColor.content = accentColor;
    });
}

function applyCustomAccent(color) {
    if (color) {
        document.documentElement.style.setProperty('--accent', color);
        document.documentElement.style.setProperty('--accent-light', color);
        document.documentElement.style.setProperty('--accent-dark', color);
        document.documentElement.style.setProperty('--accent-glow', color + '55');
    } else {
        document.documentElement.style.removeProperty('--accent');
        document.documentElement.style.removeProperty('--accent-light');
        document.documentElement.style.removeProperty('--accent-dark');
        document.documentElement.style.removeProperty('--accent-glow');
    }
    syncMetaThemeColor();
}

export function applyTheme(themeName, { persist = true, silent = false } = {}) {
    clearThemeClasses();
    if (themeName) document.body.classList.add(themeName);
    if (persist) localStorage.setItem('freedify_theme', themeName || '');
    themeOptions.forEach(o => o.classList.toggle('active', o.dataset.theme === (themeName || '')));
    if (state.customAccent) applyCustomAccent(state.customAccent);
    else syncMetaThemeColor();
    if (!silent) {
        const opt = Array.from(themeOptions).find(o => o.dataset.theme === (themeName || ''));
        if (opt) showToast(`Theme: ${opt.textContent.trim()}`);
    }
}

export function cycleTheme(direction = 1) {
    const current = localStorage.getItem('freedify_theme') || '';
    const list = ['', ...THEME_CLASSES];
    const idx = list.indexOf(current);
    const next = list[((idx === -1 ? 0 : idx) + direction + list.length) % list.length];
    applyTheme(next);
}

// Load saved theme on startup
(function loadSavedTheme() {
    const savedTheme = localStorage.getItem('freedify_theme') || '';
    applyTheme(savedTheme, { persist: false, silent: true });
})();

themeOptions.forEach(opt => {
    opt.addEventListener('click', () => applyTheme(opt.dataset.theme));
});

// ========== CUSTOM ACCENT COLOR ==========
const customAccentInput = $('#custom-accent-input');
const customAccentClear = $('#custom-accent-clear');
if (customAccentInput) {
    if (state.customAccent) customAccentInput.value = state.customAccent;
    applyCustomAccent(state.customAccent);
    customAccentInput.addEventListener('input', (e) => {
        const color = e.target.value;
        state.customAccent = color;
        localStorage.setItem('freedify_custom_accent', color);
        applyCustomAccent(color);
    });
}
if (customAccentClear) {
    customAccentClear.addEventListener('click', () => {
        state.customAccent = '';
        localStorage.removeItem('freedify_custom_accent');
        applyCustomAccent('');
        showToast('Custom accent cleared');
    });
}

// ========== HiFi MODE ==========
const hifiBtn = $('#hifi-btn');

export function updateHifiButtonUI() {
    if (hifiBtn) {
        const currentTrack = state.queue[state.currentIndex];
        const source = currentTrack?.source || '';

        const isLossySource = source === 'ytmusic' || source === 'youtube' || source === 'podcast' || source === 'import';

        if (isLossySource) {
            hifiBtn.classList.remove('hi-res');
            hifiBtn.classList.add('active', 'lossy');
            hifiBtn.title = "Playing: Compressed Audio (MP3/AAC)";
            hifiBtn.textContent = "MP3";
        } else {
            hifiBtn.classList.add('active');
            hifiBtn.classList.remove('lossy');
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

if (hifiBtn) {
    hifiBtn.addEventListener('click', () => {
        if (!state.hiResMode) {
            state.hiResMode = true;
            state.hiResQuality = '6';
            showToast('Hi-Res Mode ON — 96kHz / 24-bit', 3000);
        } else if (state.hiResQuality === '6') {
            state.hiResQuality = '5';
            showToast('Hi-Res MAX — 192kHz / 24-bit', 3000);
        } else {
            state.hiResMode = false;
            state.hiResQuality = '6';
            showToast('HiFi Mode ON — 16-bit Audio', 3000);
        }
        localStorage.setItem('freedify_hires', state.hiResMode);
        localStorage.setItem('freedify_hires_quality', state.hiResQuality);
        updateHifiButtonUI();
    });

    updateHifiButtonUI();
}

// ========== MOOD SELECTOR ==========

const MOOD_LIST = ['Focus', 'Workout', 'Chill', 'Party', 'Late Night', 'Commute'];

export function renderMoodSelector(containerEl) {
    if (!containerEl) return;

    const stats = MOOD_LIST.map(m => ({ mood: m, count: getMoodStatsForWeek(m) }));
    // Escape user-provided mood for safe injection into innerHTML
    const escapedMood = state.currentMood ? escapeHtml(state.currentMood) : '';
    const isFreeform = state.currentMood && !MOOD_LIST.includes(state.currentMood);

    containerEl.innerHTML = `
        <div class="mood-selector">
            <div class="mood-buttons">
                ${MOOD_LIST.map(m => {
                    const count = stats.find(s => s.mood === m)?.count || 0;
                    const active = state.currentMood === m ? 'active' : '';
                    return `<button class="mood-btn ${active}" data-mood="${m}">
                        ${m}${count > 0 ? ` <span class="mood-count">(${count})</span>` : ''}
                    </button>`;
                }).join('')}
            </div>
            <div class="mood-freeform">
                <input type="text" id="mood-freeform-input"
                    placeholder="Or describe your mood..."
                    value="${isFreeform ? escapedMood : ''}" />
            </div>
            ${state.currentMood ? `<div class="mood-active-label">AI Radio — Mood: ${escapedMood}</div>` : ''}
            <div class="mood-history-panel">
                <button class="mood-history-toggle" onclick="this.parentElement.classList.toggle('expanded')">
                    Top Moods This Week ▾
                </button>
                <div class="mood-history-content">
                    ${(() => {
                        const allStats = MOOD_LIST.map(m => ({ mood: m, count: getMoodStatsForWeek(m) }))
                            .filter(s => s.count > 0)
                            .sort((a, b) => b.count - a.count)
                            .slice(0, 3);
                        if (allStats.length === 0) return '<p class="mood-empty">No mood data yet. Start listening!</p>';
                        return allStats.map(s => `<div class="mood-stat-row">${s.mood}: ${s.count} plays</div>`).join('');
                    })()}
                </div>
            </div>
        </div>
    `;

    // Button click handlers
    containerEl.querySelectorAll('.mood-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mood = btn.dataset.mood;
            if (state.currentMood === mood) {
                // Deselect
                state.currentMood = null;
            } else {
                state.currentMood = mood;
            }
            localStorage.setItem('freedify_current_mood', JSON.stringify(state.currentMood));
            const freeformInput = containerEl.querySelector('#mood-freeform-input');
            if (freeformInput) freeformInput.value = '';
            renderMoodSelector(containerEl); // Re-render
            emit('moodChanged', state.currentMood);
        });
    });

    // Free-form input handler
    const freeformInput = containerEl.querySelector('#mood-freeform-input');
    if (freeformInput) {
        freeformInput.addEventListener('change', () => {
            const val = freeformInput.value.trim();
            if (val) {
                state.currentMood = val;
                containerEl.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('active'));
            } else {
                state.currentMood = null;
            }
            localStorage.setItem('freedify_current_mood', JSON.stringify(state.currentMood));
            renderMoodSelector(containerEl);
            emit('moodChanged', state.currentMood);
        });
    }
}

// ========== EVENT-BUS: THEME CYCLE ==========
on('cycleTheme', (direction) => cycleTheme(direction || 1));

// ========== KEYBOARD SHORTCUTS BUTTON (settings modal) ==========
(function initShortcutsHelpButton() {
    const btn = $('#shortcuts-help-btn');
    const help = $('#shortcuts-help');
    if (btn && help) {
        btn.addEventListener('click', () => {
            help.classList.remove('hidden');
            // Also close settings modal so help is visible in front
            settingsModal?.classList.add('hidden');
        });
    }
})();

// ========== SLEEP TIMER ==========
const sleepSelect = $('#sleep-timer-select');
const sleepStatus = $('#sleep-timer-status');
let sleepIntervalId = null;

function clearSleepTimer() {
    if (sleepIntervalId) {
        clearInterval(sleepIntervalId);
        sleepIntervalId = null;
    }
    state.sleepTimer = null;
    if (sleepStatus) {
        sleepStatus.classList.add('hidden');
        sleepStatus.textContent = '';
    }
}

function formatRemaining(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function fireSleepPause() {
    try {
        const ap = document.getElementById('audio-player');
        const ap2 = document.getElementById('audio-player-2');
        [ap, ap2].forEach(p => { if (p && !p.paused) p.pause(); });
        state.isPlaying = false;
        // Update play button via event bus
        emit('sleepTimerFired');
        showToast('😴 Sleep timer — playback paused');
    } catch (e) { console.warn('sleep pause error', e); }
}

function startSleepTimer({ minutes = null, endOfTrack = false } = {}) {
    clearSleepTimer();
    if (endOfTrack) {
        state.sleepTimer = { endOfTrack: true, endsAt: null, minutes: null };
        if (sleepStatus) {
            sleepStatus.classList.remove('hidden');
            sleepStatus.textContent = '😴 Sleep: at end of current track';
        }
        // Listen for one 'ended' event via interval polling
        sleepIntervalId = setInterval(() => {
            const ap = document.getElementById('audio-player');
            const ap2 = document.getElementById('audio-player-2');
            if (ap && ap.ended || ap2 && ap2.ended) {
                fireSleepPause();
                clearSleepTimer();
            }
        }, 500);
        return;
    }
    if (!minutes || minutes <= 0) return;
    const endsAt = Date.now() + minutes * 60_000;
    state.sleepTimer = { endOfTrack: false, endsAt, minutes };
    if (sleepStatus) sleepStatus.classList.remove('hidden');
    sleepIntervalId = setInterval(() => {
        const remaining = endsAt - Date.now();
        if (remaining <= 0) {
            fireSleepPause();
            clearSleepTimer();
            if (sleepSelect) sleepSelect.value = '0';
            return;
        }
        if (sleepStatus) sleepStatus.textContent = `😴 Sleep in ${formatRemaining(remaining)}`;
    }, 1000);
}

if (sleepSelect) {
    sleepSelect.addEventListener('change', () => {
        const v = sleepSelect.value;
        if (v === '0') { clearSleepTimer(); showToast('Sleep timer off'); return; }
        if (v === 'eot') { startSleepTimer({ endOfTrack: true }); showToast('Sleep: end of current track'); return; }
        const mins = parseInt(v, 10);
        if (!Number.isNaN(mins) && mins > 0) {
            startSleepTimer({ minutes: mins });
            showToast(`Sleep timer: ${mins} min`);
        }
    });
}

// Keyboard: N adds 15 minutes to the timer (or starts one)
on('sleepTimerNudge', (mins) => {
    const addMs = (mins || 15) * 60_000;
    const t = state.sleepTimer;
    if (t && t.endsAt) {
        const newMins = Math.round((t.endsAt - Date.now() + addMs) / 60_000);
        startSleepTimer({ minutes: Math.max(1, newMins) });
        showToast(`Sleep +${mins} min (total ~${newMins}m)`);
        if (sleepSelect) sleepSelect.value = String(newMins >= 5 && newMins <= 120 ? newMins : 0);
    } else {
        startSleepTimer({ minutes: mins || 15 });
        showToast(`Sleep timer: ${mins || 15} min`);
        if (sleepSelect) sleepSelect.value = String(mins || 15);
    }
});

// ========== ADVANCED PLAYBACK SETTINGS ==========
(function initPlaybackSettings() {
    const slider = $('#settings-speed-slider');
    const valueEl = $('#settings-speed-value');
    const preserveCb = $('#settings-preserve-pitch');

    if (slider && valueEl) {
        const current = Number(state.playbackSpeed) || 1.0;
        slider.value = String(current);
        valueEl.textContent = current.toFixed(2) + 'x';
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            if (Number.isFinite(v)) {
                valueEl.textContent = v.toFixed(2) + 'x';
                // Let playback module handle clamping + persistence
                emit('setPlaybackSpeed', v);
            }
        });
    }

    if (preserveCb) {
        preserveCb.checked = state.preservesPitch !== false;
        preserveCb.addEventListener('change', () => {
            state.preservesPitch = preserveCb.checked;
            localStorage.setItem('freedify_preserves_pitch', String(preserveCb.checked));
            emit('preservesPitchChanged');
            showToast(preserveCb.checked ? 'Preserving pitch' : 'Not preserving pitch (chipmunk mode)');
        });
    }
})();

// ========== DIAGNOSTICS ==========
$('#diagnostics-btn')?.addEventListener('click', async () => {
    const results = [];
    const check = (name, ok, detail = '') => results.push({ name, ok, detail });
    try {
        // 1. Backend /health
        const t0 = performance.now();
        const res = await fetch('/api/health').catch(() => null);
        if (res) {
            const dt = (performance.now() - t0).toFixed(0);
            check('Backend /api/health', res.ok, res.ok ? `${dt}ms` : `HTTP ${res.status}`);
        } else {
            check('Backend /api/health', false, 'No response');
        }

        // 2. localStorage usable
        try {
            localStorage.setItem('__freedify_diag__', '1');
            localStorage.removeItem('__freedify_diag__');
            check('localStorage', true, 'OK');
        } catch (e) {
            check('localStorage', false, String(e));
        }

        // 3. Audio element ready
        const ap = document.getElementById('audio-player');
        check('HTMLAudioElement', !!ap, ap ? `ready; rate=${ap.playbackRate}` : 'missing');

        // 4. MediaSession
        check('MediaSession API', 'mediaSession' in navigator, 'mediaSession' in navigator ? 'available' : 'missing');

        // 5. Service worker
        check('ServiceWorker', 'serviceWorker' in navigator, 'serviceWorker' in navigator ? 'registered' : 'unavailable');

        // 6. State integrity
        check('State: queue array', Array.isArray(state.queue), `length=${state.queue.length}`);
        check('State: library array', Array.isArray(state.library), `length=${state.library.length}`);
    } catch (e) {
        check('Diagnostics', false, String(e));
    }

    const okCount = results.filter(r => r.ok).length;
    const lines = results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    const header = `🩺 Diagnostics: ${okCount}/${results.length} passed`;
    alert([header, '', ...lines].join('\n'));
    console.groupCollapsed(header);
    results.forEach(r => console.log(r));
    console.groupEnd();
});

// ========== SELF-HEALING: GLOBAL ERROR HANDLER ==========
// Log unhandled errors to console with context, and show a soft toast so users
// know something hiccupped (without nuking playback).  Repeated storms are
// rate-limited so we never drown the user in toasts.
(function installSelfHealingErrorHandlers() {
    let lastToastAt = 0;
    let suppressedCount = 0;

    function handle(kind, message, error) {
        try {
            console.warn(`[self-heal:${kind}]`, message, error || '');
        } catch {}
        const now = Date.now();
        if (now - lastToastAt < 5000) {
            suppressedCount++;
            return;
        }
        lastToastAt = now;
        const extra = suppressedCount > 0 ? ` (+${suppressedCount} more suppressed)` : '';
        suppressedCount = 0;
        try { showToast(`⚠️ ${message}${extra}`); } catch {}
    }

    window.addEventListener('error', (e) => {
        // Ignore noisy 3rd-party errors we can't fix
        const src = e?.filename || '';
        if (src && !src.startsWith(location.origin) && !src.startsWith('/')) return;
        handle('error', e?.message || 'Unknown error', e?.error);
    });

    window.addEventListener('unhandledrejection', (e) => {
        const reason = e?.reason;
        const msg = (reason && (reason.message || reason.toString())) || 'Unhandled promise rejection';
        handle('promise', msg, reason);
    });
})();
