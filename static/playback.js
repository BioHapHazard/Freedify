/**
 * Freedify Playback Module
 * Core playback logic: playTrack, loadTrack, player controls, event handlers
 */

import { state } from './state.js';
import { emit, on } from './event-bus.js';
import { showToast, formatTime } from './utils.js';
import {
    $, audioPlayer, audioPlayer2, playerBar, playerArt, playerTitle,
    playerArtist, playerAlbum, playerYear, playBtn, prevBtn, nextBtn,
    shuffleQueueBtn, progressBar, currentTime, duration,
    fsCurrentTime, fsDuration, fsProgressBar, fsPlayBtn, fsTitle,
    fsArtist, fsArt, fsToggleBtn, fullscreenPlayer, fsCloseBtn,
    fsPrevBtn, fsNextBtn, searchInput, miniPlayerBtn, domState,
    volumeSlider, muteBtn, repeatBtn, queueBtn, queueSection,
    queueClose, queueClear, queueCount, queueContainer,
    shortcutsHelp, shortcutsClose, queueSelectAll, queueSavePlaylistBtn,
} from './dom.js';
import {
    audio, getActivePlayer, getInactivePlayer,
    performCrossfade, performGaplessSwitch, preloadNextTrack,
    initEqualizer,
} from './audio-engine.js';
import {
    addToHistory, addToPodcastHistory, addToAudiobookHistory,
    saveEpisodePosition, getEpisodePosition, clearEpisodePosition,
    markEpisodePlayed, saveMoodEvent,
} from './data.js';
import { sendTimeUpdate } from './sync.js';
import { markDirty } from './cloud-sync.js';

// ========== FORWARD DECLARATIONS (set by app.js) ==========
// These are functions from other modules that playback needs.
// They're set via setPlaybackDeps() to avoid circular imports.
let performSearch = null;
let openAlbum = null;
let showPodcastModal = null;
let updateMiniPlayer = null;
let updateMediaSession = null;
let submitNowPlaying = null;
let submitScrobble = null;
let showLoading = null;
let hideLoading = null;
let showError = null;
let updateHifiButtonUI = null;
let showVisualizerInfoBriefly = null;
let visualizerActive = false;
let openAddToPlaylistModal = null;

export function setPlaybackDeps(deps) {
    if (deps.performSearch) performSearch = deps.performSearch;
    if (deps.openAlbum) openAlbum = deps.openAlbum;
    if (deps.showPodcastModal) showPodcastModal = deps.showPodcastModal;
    if (deps.updateMiniPlayer) updateMiniPlayer = deps.updateMiniPlayer;
    if (deps.updateMediaSession) updateMediaSession = deps.updateMediaSession;
    if (deps.submitNowPlaying) submitNowPlaying = deps.submitNowPlaying;
    if (deps.submitScrobble) submitScrobble = deps.submitScrobble;
    if (deps.showLoading) showLoading = deps.showLoading;
    if (deps.hideLoading) hideLoading = deps.hideLoading;
    if (deps.showError) showError = deps.showError;
    if (deps.updateHifiButtonUI) updateHifiButtonUI = deps.updateHifiButtonUI;
    if (deps.showVisualizerInfoBriefly) showVisualizerInfoBriefly = deps.showVisualizerInfoBriefly;
    if (deps.openAddToPlaylistModal) openAddToPlaylistModal = deps.openAddToPlaylistModal;
}

export function setVisualizerActive(val) { visualizerActive = val; }

// ========== PLAYBACK ==========
export function playTrack(track) {
    if (!track || !track.id) {
        console.error("playTrack called with invalid track:", track);
        return;
    }
    const existingIndex = state.queue.findIndex(t => t && t.id === track.id);
    if (existingIndex === -1) {
        state.queue.push(track);
        state.currentIndex = state.queue.length - 1;
    } else {
        state.currentIndex = existingIndex;
    }

    if (track.source === 'podcast' || track.source === 'audiobook') {
        if (track.source === 'audiobook') { addToAudiobookHistory(track); } else { addToPodcastHistory(track); }
        const savedPos = getEpisodePosition(track.id);
        if (savedPos > 10) {
            const resumeMin = Math.floor(savedPos / 60);
            const resumeSec = savedPos % 60;
            showToast(`Resuming from ${resumeMin}:${String(resumeSec).padStart(2, '0')}`);
            track._resumeAt = savedPos;
        }
    }

    updateQueueUI();

    if (audio.preloadedTrackId === track.id && audio.preloadedReady && audio.preloadedPlayer) {
        audio.preloadedTrackId = null;
        audio.preloadedReady = false;

        updatePlayerUI();
        updateFullscreenUI(track);

        if (audio.crossfadeEnabled) {
            performCrossfade();
        } else {
            performGaplessSwitch();
        }

        updateFormatBadge(getActivePlayer().src);
        setTimeout(preloadNextTrack, 500);
        return;
    }

    loadTrack(track);
}

// ========== ALBUM ART COLOR EXTRACTION ==========
function extractDominantColor(imageUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const sampleSize = 10;
            canvas.width = sampleSize;
            canvas.height = sampleSize;

            ctx.drawImage(img, 0, 0, sampleSize, sampleSize);

            const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
            const pixels = imageData.data;

            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                const pr = pixels[i], pg = pixels[i + 1], pb = pixels[i + 2];
                const brightness = (pr + pg + pb) / 3;

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

                const playerSection = $('.player-section');
                if (playerSection) {
                    playerSection.style.background = `linear-gradient(180deg, rgba(${r}, ${g}, ${b}, 0.15) 0%, var(--bg-primary) 100%)`;
                }
            }
        } catch (e) {
        }
    };

    img.onerror = () => {
        const playerSection = $('.player-section');
        if (playerSection) {
            playerSection.style.background = '';
        }
    };

    img.src = imageUrl;
}

export function updatePlayerUI() {
    if (state.currentIndex < 0 || !state.queue[state.currentIndex]) return;
    const track = state.queue[state.currentIndex];

    playerBar.classList.remove('hidden');
    playerTitle.textContent = track.name;
    playerArtist.textContent = track.artists || '-';

    if (visualizerActive && showVisualizerInfoBriefly) {
        showVisualizerInfoBriefly();
    }

    if (playerAlbum) {
        playerAlbum.textContent = track.album || '-';
        playerAlbum.dataset.albumId = track.album_id || '';
        playerAlbum.dataset.albumName = track.album || '';
    }

    if (playerYear) {
        const year = track.release_date ? track.release_date.slice(0, 4) : '';
        playerYear.textContent = year ? `(${year})` : '';
    }

    playerArt.src = track.album_art || '/static/icon.svg';

    if (track.album_art) {
        extractDominantColor(track.album_art);
    }

    // DJ Mode Info
    const playerDJInfo = $('#player-dj-info');
    if (state.djMode && playerDJInfo) {
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
            playerDJInfo.innerHTML = '<div class="dj-badge-placeholder"></div>';
            playerDJInfo.classList.remove('hidden');
        }
    } else if (playerDJInfo) {
        playerDJInfo.classList.add('hidden');
    }

    // Update Mini Player
    if (domState.pipWindow && updateMiniPlayer) updateMiniPlayer();
}

// ========== FORMAT BADGE ==========
export async function updateFormatBadge(audioSrc) {
    const badge = document.getElementById('audio-format-badge');
    const speedBtn = document.getElementById('playback-speed-btn');
    if (!badge) return;

    if (!audioSrc || audioSrc.startsWith('blob:') || audioSrc.startsWith('file:')) {
        badge.classList.add('hidden');
        if (speedBtn) speedBtn.classList.add('hidden');
        return;
    }

    if (speedBtn) {
        // Speed control is now available for all audio sources, not just podcasts/audiobooks.
        speedBtn.classList.remove('hidden');
        applyPlaybackRate();
    }

    badge.classList.remove('hidden', 'mp3', 'flac', 'hi-res');

    let headersDetermined = false;
    if (audioSrc && audioSrc.includes('/api/stream/')) {
        try {
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
        }
    }

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

    if (updateHifiButtonUI) {
        updateHifiButtonUI();
    }
}

// ========== LOAD TRACK ==========
export async function loadTrack(track) {
    // Force-clear stale loadInProgress guard (e.g. previous load froze mid-flight)
    if (audio.loadInProgress) {
        if (audio._loadStartedAt && Date.now() - audio._loadStartedAt > 40000) {
            console.warn('loadInProgress was stale (>40s) — force-clearing');
            audio.loadInProgress = false;
        } else {
            return;
        }
    }

    audio.loadInProgress = true;
    audio._loadStartedAt = Date.now();
    if (showLoading) showLoading(`Loading "${track.name}"...`);
    state.scrobbledCurrent = false;
    playerBar.classList.remove('hidden');

    if (track.source === 'podcast' || track.source === 'audiobook') {
        if (!track._resumeAt) {
            const savedPos = getEpisodePosition(track.id);
            if (savedPos > 10) {
                const resumeMin = Math.floor(savedPos / 60);
                const resumeSec = Math.floor(savedPos % 60);
                showToast(`Resuming from ${resumeMin}:${String(resumeSec).padStart(2, '0')}`);
                track._resumeAt = savedPos;
            }
        }
        if (track.source === 'audiobook') { addToAudiobookHistory(track); } else { addToPodcastHistory(track); }
    }

    audio.preloadedTrackId = null;
    audio.preloadedPlayer = null;
    audio.preloadedReady = false;
    audio.transitionInProgress = false;
    if (audio.crossfadeTimeout) {
        clearTimeout(audio.crossfadeTimeout);
        audio.crossfadeTimeout = null;
    }

    if (audio.loadTimeoutId) {
        clearTimeout(audio.loadTimeoutId);
        audio.loadTimeoutId = null;
    }

    updatePlayerUI();
    updateQueueUI();
    updateFullscreenUI(track);

    const player = getActivePlayer();
    const playerGain = audio.activePlayer === 1 ? audio.gainNode1 : audio.gainNode2;

    if (playerGain) playerGain.gain.value = 1;

    // Enrich ListenBrainz tracks with album art
    if (track.source === 'listenbrainz' && track.album_art === '/static/icon.svg') {
        try {
            const searchQuery = track.artists + ' ' + track.name;
            const searchRes = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=1`);
            const searchData = await searchRes.json();
            if (searchData.results && searchData.results.length > 0) {
                const foundTrack = searchData.results[0];
                if (foundTrack.album_art && foundTrack.album_art !== '/static/icon.svg') {
                    track.album_art = foundTrack.album_art;
                    updatePlayerUI();
                    updateFullscreenUI(track);
                }
            }
        } catch (e) {
        }
    }

    // Set source
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
        state.lastSavedPositionTime = 0;
        player.load();

        await new Promise((resolve, reject) => {
            const cleanup = () => {
                player.oncanplay = null;
                player.onerror = null;
                player.onloadedmetadata = null;
                if (audio.loadTimeoutId) {
                    clearTimeout(audio.loadTimeoutId);
                    audio.loadTimeoutId = null;
                }
            };

            player.onloadedmetadata = () => {};

            player.oncanplay = () => {
                cleanup();
                resolve();
            };
            player.onerror = () => {
                cleanup();
                reject(new Error('Failed to load audio'));
            };
            audio.loadTimeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout loading audio'));
            }, 35000);
        });

        audio.consecutiveFailures = 0;

        if (hideLoading) hideLoading();

        // Apply playback speed & pitch preservation BEFORE play starts,
        // so the time-stretching algorithm is active from the very first
        // audio sample routed through the Web Audio graph.  Without this,
        // the player briefly runs at 1.0× through the EQ filter chain and
        // then abruptly jumps to the target rate, causing crackling.
        try {
            const preserve = state.preservesPitch !== false;
            player.preservesPitch = preserve;
            player.mozPreservesPitch = preserve;
            player.webkitPreservesPitch = preserve;
            player.playbackRate = Number(state.playbackSpeed) || 1.0;
        } catch (e) {
            console.warn('[playback] preservesPitch/playbackRate set failed', e);
        }

        player.play();
        state.isPlaying = true;
        updatePlayButton();
        if (updateMediaSession) updateMediaSession(track);

        addToHistory(track);
        updateFormatBadge(player.src);

    } catch (error) {
        console.error('Playback error:', error);
        if (hideLoading) hideLoading();
        audio.consecutiveFailures++;

        if (audio.consecutiveFailures < audio.MAX_CONSECUTIVE_FAILURES && state.currentIndex < state.queue.length - 1) {
            showToast(`Skipping "${track.name}" — failed to load`);
            audio.loadInProgress = false;
            playNext();
            return;
        } else if (audio.consecutiveFailures >= audio.MAX_CONSECUTIVE_FAILURES) {
            if (showError) showError(`Unable to play — ${audio.consecutiveFailures} tracks failed in a row. Please check your connection.`);
            audio.consecutiveFailures = 0;
        } else {
            if (showError) showError('Failed to load track. No more tracks in queue.');
        }
    } finally {
        audio.loadInProgress = false;
    }
}

// ========== PLAYER CONTROLS ==========
export function togglePlay() {
    const player = getActivePlayer();

    if (!player.src && state.queue.length > 0 && state.currentIndex >= 0) {
        loadTrack(state.queue[state.currentIndex]);
        return;
    }

    if (player.paused) {
        player.play().catch(e => {
            console.warn('Play failed:', e);
            if (audio.audioContext && audio.audioContext.state === 'suspended') {
                audio.audioContext.resume().then(() => player.play().catch(() => {}));
            }
        });
    } else {
        // Mark as intentionally paused BEFORE calling pause() so that
        // handlePause's auto-resume guard and the watchdog both see
        // state.isPlaying === false and don't override the user's action.
        state.isPlaying = false;
        updatePlayButton();
        player.pause();
    }
}

function logMoodEvent() {
    if (!state.currentMood) return;
    const player = getActivePlayer();
    const track = state.queue[state.currentIndex];
    if (!track || !player) return;
    // Skip podcasts/audiobooks — they don't participate in mood tracking
    if (track.source === 'podcast' || track.source === 'audiobook') return;
    const duration = player.duration;
    if (!isFinite(duration) || duration <= 0) return;
    const percentage = player.currentTime / duration;
    saveMoodEvent(state.currentMood, track, percentage);
}

export function playNext(forceAdvance) {
    // Clear stale transition guard (>5s means something went wrong)
    if (audio.transitionInProgress) {
        if (audio._transitionStartedAt && Date.now() - audio._transitionStartedAt > 5000) {
            console.warn('transitionInProgress was stale (>5s) — force-clearing');
            audio.transitionInProgress = false;
        } else {
            return;
        }
    }

    const currentTrack = state.queue[state.currentIndex];
    const player = getActivePlayer();

    if (!forceAdvance && currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
        const remaining = (player.duration || 0) - player.currentTime;
        if (remaining > 15) {
            player.currentTime = player.currentTime + 15;
            return;
        }
        // Less than 15s left — fall through to advance to next track
    }

    if (state.repeatMode === 'one') {
        player.currentTime = 0;
        player.play();
        return;
    }

    logMoodEvent(); // Log mood event for the track that's about to end

    if (state.currentIndex < state.queue.length - 1) {
        state.currentIndex++;
        state.scrobbledCurrent = false;

        if (audio.preloadedReady && audio.preloadedPlayer && audio.preloadedTrackId === state.queue[state.currentIndex]?.id) {
            audio.preloadedTrackId = null;
            audio.preloadedReady = false;
            audio.transitionInProgress = true;
            audio._transitionStartedAt = Date.now();
            updatePlayerUI();
            updateQueueUI();
            updateFullscreenUI(state.queue[state.currentIndex]);
            if (audio.crossfadeEnabled) {
                performCrossfade();
            } else {
                performGaplessSwitch();
            }
            // Clear transition flag after switch completes
            setTimeout(() => { audio.transitionInProgress = false; }, 2000);
            updateFormatBadge(getActivePlayer().src);
            if (updateMediaSession) updateMediaSession(state.queue[state.currentIndex]);
            addToHistory(state.queue[state.currentIndex]);
            requestAnimationFrame(() => preloadNextTrack());
        } else {
            loadTrack(state.queue[state.currentIndex]);
        }
    } else if (state.repeatMode === 'all' && state.queue.length > 0) {
        state.currentIndex = 0;
        state.scrobbledCurrent = false;
        loadTrack(state.queue[0]);
    }
}

export function playPrevious() {
    if (audio.crossfadeTimeout) { clearTimeout(audio.crossfadeTimeout); audio.crossfadeTimeout = null; }
    audio.transitionInProgress = false;

    const currentTrack = state.queue[state.currentIndex];
    const player = getActivePlayer();

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

// ========== EVENT HANDLERS ==========
function handlePlay() {
    state.isPlaying = true;
    emit('playStateChanged', true);
    updatePlayButton();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    const track = state.queue[state.currentIndex];
    if (track && submitNowPlaying) submitNowPlaying(track);
}

function handlePause(e) {
    if (e.target === getActivePlayer()) {
        const currentTrack = state.queue[state.currentIndex];
        const player = getActivePlayer();

        // Save podcast/audiobook position on any pause
        if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
            if (player.currentTime > 5) {
                saveEpisodePosition(currentTrack.id, player.currentTime);
            }
        }

        // Check if this is a background/system interrupt rather than user action.
        // If the track ended naturally, handleEnded will take care of advancing.
        // If the user didn't pause manually but the player stopped (e.g. Android
        // background throttling, network hiccup), try to resume after a short delay.
        // Skip during track transitions — the old player fires a pause event that
        // we should not try to recover from.
        if (state.isPlaying && !player.ended && player.readyState >= 2 && !audio.transitionInProgress && !audio.loadInProgress) {
            // Likely a background interrupt — attempt auto-resume
            setTimeout(() => {
                const p = getActivePlayer();
                if (state.isPlaying && p.paused && !p.ended && p.readyState >= 2 && !audio.transitionInProgress && !audio.loadInProgress) {
                    console.warn('Auto-resuming after unexpected pause');
                    p.play().catch(() => {});
                }
            }, 1500);
            return; // Don't update UI state to paused — we're trying to recover
        }

        state.isPlaying = false;
        emit('playStateChanged', false);
        updatePlayButton();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }
}

function handleProgress() {
    const player = getActivePlayer();
    if (player.duration > 0 && player.buffered.length > 0) {
        const bufferedEnd = player.buffered.end(player.buffered.length - 1);
        if (bufferedEnd >= player.duration - 60) {
            preloadNextTrack();
        }
    }
}

function handleEnded(e) {
    // Always clear transition flags when a track ends — they're moot now
    audio.transitionInProgress = false;
    if (audio.crossfadeTimeout) {
        clearTimeout(audio.crossfadeTimeout);
        audio.crossfadeTimeout = null;
    }
    if (e.target !== getActivePlayer()) return;

    const currentTrack = state.queue[state.currentIndex];
    if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
        markEpisodePlayed(currentTrack.id);
        clearEpisodePosition(currentTrack.id);
    }

    playNext(true);
}

function handleTimeUpdate() {
    if (domState.pipWindow && updateMiniPlayer) updateMiniPlayer();

    const player = getActivePlayer();
    if (state.syncEnabled) sendTimeUpdate(player.currentTime);
    if (player.duration) {
        currentTime.textContent = formatTime(player.currentTime);
        duration.textContent = formatTime(player.duration);
        progressBar.value = (player.currentTime / player.duration) * 100;

        fsCurrentTime.textContent = currentTime.textContent;
        fsDuration.textContent = duration.textContent;
        fsProgressBar.value = progressBar.value;

        progressBar.style.setProperty('--value', progressBar.value + '%');
        fsProgressBar.style.setProperty('--value', progressBar.value + '%');

        if (!state.scrobbledCurrent && state.queue[state.currentIndex]) {
            if (player.currentTime > 240 || player.currentTime > player.duration / 2) {
                if (submitScrobble) submitScrobble(state.queue[state.currentIndex]);
            }
        }

        const currentTrack = state.queue[state.currentIndex];
        if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
            if (player.currentTime > 5 && player.currentTime > state.lastSavedPositionTime + 10) {
                saveEpisodePosition(currentTrack.id, player.currentTime);
                state.lastSavedPositionTime = player.currentTime;
            }
        }

        const timeRemaining = player.duration - player.currentTime;
        if (timeRemaining <= 60 && timeRemaining > 0 && !audio.preloadedTrackId) {
            preloadNextTrack();
        }

        const crossfadeTime = audio.crossfadeEnabled ? audio.CROSSFADE_DURATION / 1000 : 0.2;

        if (timeRemaining <= crossfadeTime && timeRemaining > 0 && audio.preloadedPlayer && !audio.crossfadeTimeout && !audio.transitionInProgress) {
            audio.crossfadeTimeout = setTimeout(() => {
                audio.crossfadeTimeout = null;
            }, crossfadeTime * 1000 + 1000);
            playNext();
        }
    }
}

// ========== STALL RECOVERY ==========
function handleStalled(e) {
    if (e.target !== getActivePlayer()) return;
    console.warn('Audio stream stalled — starting 10s recovery timer');

    if (audio.stallRecoveryTimer) clearTimeout(audio.stallRecoveryTimer);

    audio.stallRecoveryTimer = setTimeout(() => {
        const player = getActivePlayer();
        if (player.paused || player.ended) return;

        const currentPos = player.currentTime;
        console.warn('Stall recovery: seeking to', currentPos, 'to force reconnect');
        player.currentTime = currentPos;

        audio.stallRecoveryTimer = setTimeout(() => {
            if (!player.paused && player.readyState < 3) {
                console.warn('Stall unrecoverable — auto-skipping');
                showToast('Stream stalled — skipping to next track');
                playNext();
            }
        }, 10000);
    }, 10000);
}

function handleWaiting(e) {
    if (e.target !== getActivePlayer()) return;
    if (audio.waitingWatchdog) clearTimeout(audio.waitingWatchdog);
    audio.waitingWatchdog = setTimeout(() => {
        const player = getActivePlayer();
        if (!player.paused && player.readyState < 3) {
            console.warn('Waiting watchdog triggered — attempting seek recovery');
            player.currentTime = player.currentTime;
        }
    }, 15000);
}

function handlePlaying() {
    if (audio.stallRecoveryTimer) { clearTimeout(audio.stallRecoveryTimer); audio.stallRecoveryTimer = null; }
    if (audio.waitingWatchdog) { clearTimeout(audio.waitingWatchdog); audio.waitingWatchdog = null; }
}

// ========== PLAYBACK WATCHDOG ==========
// Periodic check: if we think we're playing but audio is stalled/paused,
// attempt recovery. This catches edge cases missed by event handlers
// (e.g. Android background throttling, frozen timers).
setInterval(() => {
    if (!state.isPlaying) return;
    // Don't interfere while a track is actively loading or transitioning
    if (audio.loadInProgress || audio.transitionInProgress) return;
    const player = getActivePlayer();
    if (!player || !player.src) return;

    // Player is paused but we think we're playing
    if (player.paused && !player.ended) {
        if (player.readyState >= 2) {
            console.warn('[Watchdog] Player paused unexpectedly — resuming');
            player.play().catch(() => {});
        } else if (player.readyState === 0 && state.currentIndex < state.queue.length - 1) {
            // Player completely lost its source — skip to next
            console.warn('[Watchdog] Player source lost — advancing to next track');
            playNext(true);
        }
    }

    // Player reached the end but handleEnded didn't fire (rare)
    if (!player.paused && player.ended && state.currentIndex < state.queue.length - 1) {
        console.warn('[Watchdog] Track ended but handler missed — advancing');
        playNext(true);
    }
}, 5000);

// ========== BIND EVENTS ==========
audioPlayer.addEventListener('play', handlePlay);
audioPlayer2.addEventListener('play', handlePlay);
audioPlayer.addEventListener('pause', handlePause);
audioPlayer2.addEventListener('pause', handlePause);
audioPlayer.addEventListener('progress', handleProgress);
audioPlayer2.addEventListener('progress', handleProgress);
audioPlayer.addEventListener('ended', handleEnded);
audioPlayer2.addEventListener('ended', handleEnded);
audioPlayer.addEventListener('stalled', handleStalled);
audioPlayer2.addEventListener('stalled', handleStalled);
audioPlayer.addEventListener('waiting', handleWaiting);
audioPlayer2.addEventListener('waiting', handleWaiting);
audioPlayer.addEventListener('playing', handlePlaying);
audioPlayer2.addEventListener('playing', handlePlaying);
audioPlayer.addEventListener('timeupdate', handleTimeUpdate);
audioPlayer2.addEventListener('timeupdate', handleTimeUpdate);

// Player button controls
playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', playPrevious);
if (miniPlayerBtn) miniPlayerBtn.addEventListener('click', () => emit('toggleMiniPlayer'));
nextBtn.addEventListener('click', () => playNext());

// ========== PLAYBACK SPEED ==========
// Expanded speed options — available for ALL sources (music, podcasts, audiobooks).
export const PLAYBACK_SPEEDS = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

function formatSpeed(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '1.0x';
    return (Number.isInteger(n) || n.toFixed(2).endsWith('0') ? n.toFixed(1) : n.toFixed(2)) + 'x';
}

export function applyPlaybackRate() {
    const rate = Number(state.playbackSpeed) || 1.0;
    const preservePitch = state.preservesPitch !== false;
    [audioPlayer, audioPlayer2].forEach(p => {
        if (!p) return;
        try {
            // preservesPitch is the standard name; prefixed variants for older browsers
            p.preservesPitch = preservePitch;
            p.mozPreservesPitch = preservePitch;
            p.webkitPreservesPitch = preservePitch;
            p.playbackRate = rate;
        } catch (e) {
            console.warn('[playback] Failed to set playbackRate', e);
        }
    });
    const speedBtn = document.getElementById('playback-speed-btn');
    if (speedBtn) speedBtn.textContent = formatSpeed(rate);
    try { localStorage.setItem('freedify_playback_speed', String(rate)); } catch {}
}

export function setPlaybackSpeed(rate, { toast = true } = {}) {
    const clamped = Math.max(0.25, Math.min(4.0, Number(rate) || 1.0));
    state.playbackSpeed = Math.round(clamped * 100) / 100;
    applyPlaybackRate();
    if (toast) showToast('Speed: ' + formatSpeed(state.playbackSpeed));
}

export function cyclePlaybackSpeed(direction = 1) {
    const speeds = PLAYBACK_SPEEDS;
    // Snap to the closest known speed first, then step
    let idx = speeds.findIndex(s => Math.abs(s - state.playbackSpeed) < 0.01);
    if (idx === -1) {
        idx = speeds.reduce((best, s, i) =>
            Math.abs(s - state.playbackSpeed) < Math.abs(speeds[best] - state.playbackSpeed) ? i : best, 0);
    }
    const next = speeds[(idx + direction + speeds.length) % speeds.length];
    setPlaybackSpeed(next);
}

const playbackSpeedBtn = document.getElementById('playback-speed-btn');
if (playbackSpeedBtn) {
    playbackSpeedBtn.addEventListener('click', () => cyclePlaybackSpeed(1));
    playbackSpeedBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); cyclePlaybackSpeed(-1); });
}

// Apply saved speed immediately on module load (so new tracks start at the right rate).
applyPlaybackRate();

// Bridge: allow other modules (ui.js settings slider, shortcuts) to drive speed without importing
on('setPlaybackSpeed', (v) => setPlaybackSpeed(v, { toast: false }));
on('preservesPitchChanged', () => applyPlaybackRate());
on('sleepTimerFired', () => { try { updatePlayButton(); } catch {} });

// Shuffle queue
shuffleQueueBtn.addEventListener('click', () => {
    if (state.queue.length <= 1) return;

    const currentTrack = state.queue[state.currentIndex];
    const otherTracks = state.queue.filter((_, i) => i !== state.currentIndex);

    for (let i = otherTracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [otherTracks[i], otherTracks[j]] = [otherTracks[j], otherTracks[i]];
    }

    state.queue = [currentTrack, ...otherTracks];
    state.currentIndex = 0;

    updateQueueUI();

    shuffleQueueBtn.style.transform = 'scale(1.2)';
    setTimeout(() => shuffleQueueBtn.style.transform = '', 200);
});

// Progress bar seek
progressBar.addEventListener('input', (e) => {
    const player = getActivePlayer();
    if (player.duration && Number.isFinite(player.duration)) {
        player.currentTime = (e.target.value / 100) * player.duration;
        e.target.style.setProperty('--value', e.target.value + '%');
        if (fsProgressBar) fsProgressBar.style.setProperty('--value', e.target.value + '%');
    }
});

export function updatePlayButton() {
    playBtn.textContent = state.isPlaying ? '⏸' : '▶';
    updateFSPlayBtn();
}

// ========== FULLSCREEN PLAYER ==========
export function updateFullscreenUI(track) {
    if (!track) return;
    fsTitle.textContent = track.name;
    const year = track.release_date ? track.release_date.slice(0, 4) : '';
    fsArtist.textContent = year ? `${track.artists} • ${year}` : track.artists;
    fsArt.src = track.album_art || '/static/icon.svg';

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

export function toggleFullScreen() {
    fullscreenPlayer.classList.toggle('hidden');
    if (!fullscreenPlayer.classList.contains('hidden')) {
        if (state.currentIndex >= 0) {
            updateFullscreenUI(state.queue[state.currentIndex]);
        }
    }
}

// FS Controls
if (fsToggleBtn) fsToggleBtn.addEventListener('click', toggleFullScreen);
if (fsCloseBtn) fsCloseBtn.addEventListener('click', toggleFullScreen);
if (fsPlayBtn) fsPlayBtn.addEventListener('click', () => playBtn.click());

const fsHeartBtn = $('#fs-heart-btn');
if (fsPrevBtn) {
    fsPrevBtn.addEventListener('click', () => {
        const currentTrack = state.queue[state.currentIndex];
        const player = getActivePlayer();
        if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
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
        if (currentTrack && (currentTrack.source === 'podcast' || currentTrack.source === 'audiobook')) {
            const remaining = (player.duration || 0) - player.currentTime;
            if (remaining > 15) {
                player.currentTime = player.currentTime + 15;
            } else {
                playNext(true);
            }
        } else {
            nextBtn.click();
        }
    });
}

if (fsHeartBtn) {
    fsHeartBtn.addEventListener('click', () => {
        const currentTrack = state.queue[state.currentIndex];
        if (currentTrack && openAddToPlaylistModal) {
            openAddToPlaylistModal(currentTrack);
        } else {
            showToast('No track playing');
        }
    });
}

// FS Progress bar
if (fsProgressBar) {
    fsProgressBar.addEventListener('input', (e) => {
        const player = getActivePlayer();
        if (player.duration) {
            player.currentTime = (e.target.value / 100) * player.duration;
        }
    });
}

// More menu
const moreControlsBtn = $('#more-controls-btn');
const playerMoreMenu = $('#player-more-menu');

if (moreControlsBtn && playerMoreMenu) {
    moreControlsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playerMoreMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!playerMoreMenu.classList.contains('hidden') &&
            !playerMoreMenu.contains(e.target) &&
            e.target !== moreControlsBtn) {
            playerMoreMenu.classList.add('hidden');
        }
    });
}

// Nav links
playerTitle.classList.add('clickable-link');
playerArtist.classList.add('clickable-link');

playerTitle.addEventListener('click', () => {
    if (state.currentIndex >= 0 && !fullscreenPlayer.classList.contains('hidden')) toggleFullScreen();
    if (state.currentIndex >= 0) {
        const track = state.queue[state.currentIndex];
        if (performSearch) performSearch(track.name + " " + track.artists);
    }
});

if (playerAlbum) {
    playerAlbum.addEventListener('click', () => {
        const albumId = playerAlbum.dataset.albumId;
        if (albumId && openAlbum) {
            openAlbum(albumId);
        }
    });
}

playerArtist.addEventListener('click', () => {
    if (state.currentIndex >= 0 && performSearch) {
        performSearch(state.queue[state.currentIndex].artists);
    }
});

// ========== QUEUE UI & MANAGEMENT ==========
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

// Queue select-all
queueSelectAll?.addEventListener('click', () => {
    const cbs = queueContainer.querySelectorAll('.queue-select-cb');
    cbs.forEach(cb => { cb.checked = queueSelectAll.checked; });
});

// Queue download
$('#queue-download-btn')?.addEventListener('click', () => {
    if (state.queue.length === 0) return;

    const checkedIndices = new Set();
    document.querySelectorAll('#queue-container .queue-select-cb:checked').forEach(cb => {
        checkedIndices.add(parseInt(cb.dataset.index));
    });

    const selectedTracks = state.queue.filter((_, i) => checkedIndices.has(i));

    if (selectedTracks.length === 0) {
        showToast('Please select at least one track to download');
        return;
    }

    emit('openDownloadModal', { tracks: selectedTracks, isBatch: true });
});

// Save queue as playlist
queueSavePlaylistBtn?.addEventListener('click', () => {
    if (state.queue.length === 0) {
        showToast('Queue is empty');
        return;
    }

    const checkedIndices = new Set();
    queueContainer.querySelectorAll('.queue-select-cb:checked').forEach(cb => {
        checkedIndices.add(parseInt(cb.dataset.index, 10));
    });

    const tracksToSave = checkedIndices.size > 0
        ? state.queue.filter((_, i) => checkedIndices.has(i))
        : state.queue;

    if (window.openAddToPlaylistModal) {
        window.openAddToPlaylistModal(tracksToSave);
    } else {
        showToast('Playlist feature unavailable');
    }
});

// Queue item clicks (delegated)
queueContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('queue-select-cb')) {
        e.stopPropagation();
        return;
    }

    const removeBtn = e.target.closest('.queue-remove-btn');
    if (removeBtn) {
        e.stopPropagation();
        const index = parseInt(removeBtn.dataset.index, 10);
        window.removeFromQueue(index);
        return;
    }

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
        const queueData = {
            queue: state.queue,
            currentIndex: state.currentIndex
        };
        localStorage.setItem('freedify_queue', JSON.stringify(queueData));
        markDirty('queue_state');
    } catch (e) {
        console.warn('Could not save queue to storage:', e);
    }
}

export function loadQueueFromStorage() {
    try {
        const saved = localStorage.getItem('freedify_queue');
        if (saved) {
            const queueData = JSON.parse(saved);
            if (queueData.queue && Array.isArray(queueData.queue) && queueData.queue.length > 0) {
                state.queue = queueData.queue;
                state.currentIndex = queueData.currentIndex || 0;
                updateQueueUI();
                if (state.queue[state.currentIndex]) {
                    updatePlayerUI();
                }
            }
        }
    } catch (e) {
        console.warn('Could not load queue from storage:', e);
    }
}

import { escapeHtml } from './utils.js';

export function updateQueueUI() {
    queueCount.textContent = `(${state.queue.length})`;

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

    const currentEl = queueContainer.querySelector(`[data-index="${state.currentIndex}"]`);
    if (currentEl) {
        currentEl.classList.add('playing');
        currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Init drag & drop
    setTimeout(initQueueDragDrop, 0);

    // Sync select-all checkbox state with individual checkboxes
    if (queueSelectAll) {
        const allCbs = queueContainer.querySelectorAll('.queue-select-cb');
        allCbs.forEach(cb => {
            cb.addEventListener('change', () => {
                const total = allCbs.length;
                const checked = queueContainer.querySelectorAll('.queue-select-cb:checked').length;
                queueSelectAll.checked = checked === total;
                queueSelectAll.indeterminate = checked > 0 && checked < total;
            });
        });
    }
}

// ========== REMOVE FROM QUEUE ==========
export function removeFromQueue(index) {
    if (index === state.currentIndex) {
        state.queue.splice(index, 1);
        if (state.queue.length === 0) {
            getActivePlayer().pause();
            state.isPlaying = false;
            updatePlayButton();
            state.currentIndex = -1;
            playerTitle.textContent = 'No track playing';
            playerArtist.textContent = '-';
            playerArt.src = '';
            fsTitle.textContent = 'No track playing';
            fsArtist.textContent = 'Select music';
        } else {
            if (index >= state.queue.length) {
                state.currentIndex = 0;
                loadTrack(state.queue[0]);
            } else {
                playTrack(state.queue[index]);
            }
        }
    } else {
        state.queue.splice(index, 1);
        if (index < state.currentIndex) {
            state.currentIndex--;
        }
        updateQueueUI();
    }
    emit('queueChanged');
}

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

            const [movedTrack] = state.queue.splice(draggedIndex, 1);
            state.queue.splice(targetIndex, 0, movedTrack);

            if (state.currentIndex === draggedIndex) {
                state.currentIndex = targetIndex;
            } else if (draggedIndex < state.currentIndex && targetIndex >= state.currentIndex) {
                state.currentIndex--;
            } else if (draggedIndex > state.currentIndex && targetIndex <= state.currentIndex) {
                state.currentIndex++;
            }

            updateQueueUI();
            emit('queueChanged');
            showToast('Queue reordered');
        });
    });
}

// ========== VOLUME CONTROL ==========
export function updateVolume(vol) {
    if (vol < 0) vol = 0;
    if (vol > 1) vol = 1;

    state.volume = vol;
    audioPlayer.volume = vol;
    audioPlayer2.volume = vol;
    state.muted = vol === 0;

    localStorage.setItem('freedify_volume', vol.toString());

    const sliderVal = Math.round(vol * 100);
    if (volumeSlider.value != sliderVal) volumeSlider.value = sliderVal;

    if (domState.pipWindow) {
        const waVol = domState.pipWindow.document.getElementById('wa-vol');
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
    emit('repeatModeChanged', state.repeatMode);
});

// ========== KEYBOARD SHORTCUTS ==========
shortcutsClose.addEventListener('click', () => {
    shortcutsHelp.classList.add('hidden');
});

document.addEventListener('keydown', (e) => {
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
        case '[':
            e.preventDefault();
            cyclePlaybackSpeed(-1);
            break;
        case ']':
            e.preventDefault();
            cyclePlaybackSpeed(1);
            break;
        case '\\':
            e.preventDefault();
            setPlaybackSpeed(1.0);
            break;
        case 't':
        case 'T':
            e.preventDefault();
            emit('cycleTheme', e.shiftKey ? -1 : 1);
            break;
        case 'b':
        case 'B':
            e.preventDefault();
            setABRepeatPoint();
            break;
        case 'z':
        case 'Z':
            e.preventDefault();
            clearABRepeat();
            break;
        case 'n':
        case 'N':
            e.preventDefault();
            emit('sleepTimerNudge', 15);
            break;
        case '/':
            if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                if (searchInput) { searchInput.focus(); searchInput.select?.(); }
            }
            break;
        case '?':
            shortcutsHelp.classList.toggle('hidden');
            break;
    }
});

// ========== A-B REPEAT ==========
export function setABRepeatPoint() {
    const player = getActivePlayer();
    const t = player?.currentTime;
    if (!Number.isFinite(t)) return;
    if (state.abRepeat.a == null) {
        state.abRepeat.a = t;
        showToast(`A-B: A point set at ${formatTime(t)}`);
    } else if (state.abRepeat.b == null) {
        if (t <= state.abRepeat.a + 0.5) {
            showToast('A-B: B must be after A — pick a later point');
            return;
        }
        state.abRepeat.b = t;
        showToast(`A-B: looping ${formatTime(state.abRepeat.a)} → ${formatTime(t)}`);
    } else {
        // Cycle through: third press clears
        clearABRepeat();
    }
}

export function clearABRepeat() {
    if (state.abRepeat.a == null && state.abRepeat.b == null) return;
    state.abRepeat.a = null;
    state.abRepeat.b = null;
    showToast('A-B repeat cleared');
}

function maybeApplyABRepeat() {
    const { a, b } = state.abRepeat;
    if (a == null || b == null) return;
    const player = getActivePlayer();
    if (!player) return;
    if (player.currentTime >= b) {
        try { player.currentTime = a; } catch {}
    }
}
setInterval(maybeApplyABRepeat, 250);
