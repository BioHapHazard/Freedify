/**
 * Freedify - Music Streaming PWA
 * Enhanced search with albums, artists, playlists, and Spotify URL support
 */

// ========== STATE ==========
const state = {
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    searchType: 'track',
    detailTracks: [],  // Tracks in current detail view
};

// ========== DOM ELEMENTS ==========
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

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
const queueSection = $('#queue-section');
const queueContainer = $('#queue-container');
const queueCount = $('#queue-count');
const queueClear = $('#queue-clear');
const queueBtn = $('#queue-btn');
const loadingOverlay = $('#loading-overlay');
const loadingText = $('#loading-text');
const errorMessage = $('#error-message');
const errorText = $('#error-text');
const errorRetry = $('#error-retry');
const playerBar = $('#player-bar');
const playerArt = $('#player-art');
const playerTitle = $('#player-title');
const playerArtist = $('#player-artist');
const playBtn = $('#play-btn');
const prevBtn = $('#prev-btn');
const nextBtn = $('#next-btn');
const progressBar = $('#progress-bar');
const currentTime = $('#current-time');
const duration = $('#duration');
const audioPlayer = $('#audio-player');

// ========== SEARCH ==========
let searchTimeout;

searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    
    if (!query) {
        showEmptyState();
        return;
    }
    
    searchTimeout = setTimeout(() => performSearch(query), 400);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        clearTimeout(searchTimeout);
        performSearch(searchInput.value.trim());
    }
});

searchClear.addEventListener('click', () => {
    searchInput.value = '';
    showEmptyState();
    searchInput.focus();
});

// Search type selector
typeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        typeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.searchType = btn.dataset.type;
        
        const query = searchInput.value.trim();
        if (query) performSearch(query);
    });
});

async function performSearch(query) {
    if (!query) return;
    
    showLoading(`Searching for "${query}"...`);
    
    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${state.searchType}`);
        const data = await response.json();
        
        if (!response.ok) throw new Error(data.detail || 'Search failed');
        
        hideLoading();
        
        // Check if it was a Spotify URL
        if (data.is_url && data.tracks) {
            // Auto-open detail view for albums/playlists
            if (data.type === 'album' || data.type === 'playlist' || data.type === 'artist') {
                showDetailView(data.results[0], data.tracks);
                return;
            }
        }
        
        renderResults(data.results, data.type || state.searchType);
        
    } catch (error) {
        console.error('Search error:', error);
        showError(error.message || 'Search failed. Please try again.');
    }
}

function renderResults(results, type) {
    if (!results || results.length === 0) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">🔍</span>
                <p>No results found</p>
            </div>
        `;
        return;
    }
    
    resultsContainer.innerHTML = results.map(item => {
        if (type === 'album') return renderAlbumCard(item);
        if (type === 'artist') return renderArtistCard(item);
        return renderTrackCard(item);
    }).join('');
    
    // Add click handlers
    if (type === 'album') {
        $$('.album-item').forEach((el, i) => {
            el.addEventListener('click', () => openAlbum(results[i].id));
        });
    } else if (type === 'artist') {
        $$('.artist-item').forEach((el, i) => {
            el.addEventListener('click', () => openArtist(results[i].id));
        });
    } else {
        $$('.track-item').forEach((el, i) => {
            el.addEventListener('click', () => playTrack(results[i]));
        });
    }
}

function renderTrackCard(track) {
    return `
        <div class="track-item" data-id="${track.id}">
            <img class="track-album-art" src="${track.album_art || '/static/icon.svg'}" alt="Album art" loading="lazy">
            <div class="track-info">
                <p class="track-name">${escapeHtml(track.name)}</p>
                <p class="track-artist">${escapeHtml(track.artists)}</p>
            </div>
            <span class="track-duration">${track.duration}</span>
        </div>
    `;
}

function renderAlbumCard(album) {
    return `
        <div class="album-item" data-id="${album.id}">
            <img class="album-art" src="${album.album_art || '/static/icon.svg'}" alt="Album art" loading="lazy">
            <div class="album-info">
                <p class="album-name">${escapeHtml(album.name)}</p>
                <p class="album-artist">${escapeHtml(album.artists)}</p>
                <p class="album-tracks-count">${album.total_tracks || ''} tracks • ${album.release_date?.slice(0, 4) || ''}</p>
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

// ========== ALBUM / ARTIST / PLAYLIST DETAIL VIEW ==========
async function openAlbum(albumId) {
    showLoading('Loading album...');
    try {
        const response = await fetch(`/api/album/${albumId}`);
        const album = await response.json();
        if (!response.ok) throw new Error(album.detail);
        
        hideLoading();
        showDetailView(album, album.tracks);
    } catch (error) {
        showError('Failed to load album');
    }
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

function showDetailView(item, tracks) {
    state.detailTracks = tracks || [];
    
    // Render info section
    const isArtist = item.type === 'artist';
    const image = item.album_art || item.image || '/static/icon.svg';
    const subtitle = item.artists || item.owner || (item.genres?.slice(0, 2).join(', ')) || '';
    const stats = item.total_tracks ? `${item.total_tracks} tracks` : 
                  item.followers ? `${(item.followers / 1000).toFixed(0)}K followers` : '';
    
    detailInfo.innerHTML = `
        <img class="detail-art${isArtist ? ' artist-art' : ''}" src="${image}" alt="Cover">
        <div class="detail-meta">
            <p class="detail-name">${escapeHtml(item.name)}</p>
            <p class="detail-artist">${escapeHtml(subtitle)}</p>
            <p class="detail-stats">${stats}</p>
        </div>
    `;
    
    // Render tracks
    detailTracks.innerHTML = tracks.map((t, i) => `
        <div class="track-item" data-index="${i}">
            <img class="track-album-art" src="${t.album_art || image}" alt="Art" loading="lazy">
            <div class="track-info">
                <p class="track-name">${escapeHtml(t.name)}</p>
                <p class="track-artist">${escapeHtml(t.artists)}</p>
            </div>
            <span class="track-duration">${t.duration}</span>
        </div>
    `).join('');
    
    // Add click handlers
    $$('#detail-tracks .track-item').forEach((el, i) => {
        el.addEventListener('click', () => playTrack(tracks[i]));
    });
    
    // Show detail view
    detailView.classList.remove('hidden');
    resultsSection.classList.add('hidden');
}

function hideDetailView() {
    detailView.classList.add('hidden');
    resultsSection.classList.remove('hidden');
}

backBtn.addEventListener('click', hideDetailView);

queueAllBtn.addEventListener('click', () => {
    if (state.detailTracks.length === 0) return;
    
    // Add all tracks to queue
    state.detailTracks.forEach(track => {
        if (!state.queue.find(t => t.id === track.id)) {
            state.queue.push(track);
        }
    });
    
    updateQueueUI();
    
    // Start playing first if nothing is playing
    if (state.currentIndex === -1 && state.queue.length > 0) {
        state.currentIndex = 0;
        loadTrack(state.queue[0]);
    }
    
    hideDetailView();
});

// ========== PLAYBACK ==========
function playTrack(track) {
    // Add to queue if not already there
    const existingIndex = state.queue.findIndex(t => t.id === track.id);
    if (existingIndex === -1) {
        state.queue.push(track);
        state.currentIndex = state.queue.length - 1;
    } else {
        state.currentIndex = existingIndex;
    }
    
    updateQueueUI();
    loadTrack(track);
}

async function loadTrack(track) {
    showLoading(`Loading "${track.name}"...`);
    playerBar.classList.remove('hidden');
    
    // Update player UI
    playerTitle.textContent = track.name;
    playerArtist.textContent = track.artists;
    playerArt.src = track.album_art || '/static/icon.svg';
    
    // Build stream URL
    const query = `${track.name} ${track.artists}`;
    const streamUrl = `/api/stream/${track.isrc || track.id}?q=${encodeURIComponent(query)}`;
    
    try {
        audioPlayer.src = streamUrl;
        audioPlayer.load();
        
        await new Promise((resolve, reject) => {
            audioPlayer.oncanplay = resolve;
            audioPlayer.onerror = () => reject(new Error('Failed to load audio'));
            setTimeout(() => reject(new Error('Timeout loading audio')), 120000);
        });
        
        hideLoading();
        audioPlayer.play();
        state.isPlaying = true;
        updatePlayButton();
        updateMediaSession(track);
        
    } catch (error) {
        console.error('Playback error:', error);
        showError('Failed to load track. Please try again.');
    }
}

// Player controls
playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', playPrevious);
nextBtn.addEventListener('click', playNext);

function togglePlay() {
    if (audioPlayer.paused) {
        audioPlayer.play();
    } else {
        audioPlayer.pause();
    }
}

function playNext() {
    if (state.currentIndex < state.queue.length - 1) {
        state.currentIndex++;
        loadTrack(state.queue[state.currentIndex]);
    }
}

function playPrevious() {
    if (audioPlayer.currentTime > 3) {
        audioPlayer.currentTime = 0;
    } else if (state.currentIndex > 0) {
        state.currentIndex--;
        loadTrack(state.queue[state.currentIndex]);
    }
}

audioPlayer.addEventListener('play', () => {
    state.isPlaying = true;
    updatePlayButton();
});

audioPlayer.addEventListener('pause', () => {
    state.isPlaying = false;
    updatePlayButton();
});

audioPlayer.addEventListener('ended', playNext);

audioPlayer.addEventListener('timeupdate', () => {
    if (audioPlayer.duration) {
        currentTime.textContent = formatTime(audioPlayer.currentTime);
        duration.textContent = formatTime(audioPlayer.duration);
        progressBar.value = (audioPlayer.currentTime / audioPlayer.duration) * 100;
    }
});

progressBar.addEventListener('input', (e) => {
    if (audioPlayer.duration) {
        audioPlayer.currentTime = (e.target.value / 100) * audioPlayer.duration;
    }
});

function updatePlayButton() {
    playBtn.textContent = state.isPlaying ? '⏸' : '▶';
}

// ========== QUEUE ==========
queueBtn.addEventListener('click', () => {
    queueSection.classList.toggle('hidden');
});

queueClear.addEventListener('click', () => {
    state.queue = [];
    state.currentIndex = -1;
    updateQueueUI();
});

function updateQueueUI() {
    queueCount.textContent = `(${state.queue.length})`;
    
    if (state.queue.length === 0) {
        queueContainer.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);padding:24px;">Queue is empty</p>';
        return;
    }
    
    queueContainer.innerHTML = state.queue.map((track, i) => `
        <div class="track-item${i === state.currentIndex ? ' playing' : ''}" data-index="${i}">
            <img class="track-album-art" src="${track.album_art || '/static/icon.svg'}" alt="Art" style="width:40px;height:40px;">
            <div class="track-info">
                <p class="track-name" style="font-size:0.875rem;">${escapeHtml(track.name)}</p>
                <p class="track-artist">${escapeHtml(track.artists)}</p>
            </div>
        </div>
    `).join('');
    
    $$('#queue-container .track-item').forEach((el, i) => {
        el.addEventListener('click', () => {
            state.currentIndex = i;
            loadTrack(state.queue[i]);
        });
    });
}

// ========== MEDIA SESSION ==========
function updateMediaSession(track) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.name,
            artist: track.artists,
            album: track.album || '',
            artwork: track.album_art ? [{ src: track.album_art, sizes: '512x512' }] : []
        });
        
        navigator.mediaSession.setActionHandler('play', () => audioPlayer.play());
        navigator.mediaSession.setActionHandler('pause', () => audioPlayer.pause());
        navigator.mediaSession.setActionHandler('previoustrack', playPrevious);
        navigator.mediaSession.setActionHandler('nexttrack', playNext);
    }
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
    resultsContainer.innerHTML = `
        <div class="empty-state">
            <span class="empty-icon">🔍</span>
            <p>Search for your favorite music</p>
            <p class="hint">Or paste a Spotify link to an album or playlist</p>
        </div>
    `;
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// ========== KEYBOARD SHORTCUTS ==========
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    
    switch (e.code) {
        case 'Space':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowRight':
            if (e.shiftKey) audioPlayer.currentTime += 10;
            else playNext();
            break;
        case 'ArrowLeft':
            if (e.shiftKey) audioPlayer.currentTime -= 10;
            else playPrevious();
            break;
    }
});

// ========== SERVICE WORKER ==========
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
}

// Initial state
showEmptyState();
