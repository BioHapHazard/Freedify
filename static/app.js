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
    repeatMode: 'none', // 'none' | 'all' | 'one'
    volume: 1,
    muted: false,
    crossfadeDuration: 3, // seconds
    playlists: JSON.parse(localStorage.getItem('freedify_playlists') || '[]'), // User playlists
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
const shuffleBtn = $('#shuffle-btn');
const queueSection = $('#queue-section');
const queueContainer = $('#queue-container');
const queueClose = $('#queue-close');
const queueClear = $('#queue-clear');
const queueCount = $('#queue-count');
const queueBtn = $('#queue-btn');

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
const playBtn = $('#play-btn');
const prevBtn = $('#prev-btn');
const nextBtn = $('#next-btn');
const shuffleQueueBtn = $('#shuffle-queue-btn');
const repeatBtn = $('#repeat-btn');
const progressBar = $('#progress-bar');
const currentTime = $('#current-time');
const duration = $('#duration');
const audioPlayer = $('#audio-player');

// Volume Controls
const volumeSlider = $('#volume-slider');
const muteBtn = $('#mute-btn');

// Toast & Shortcuts
const toastContainer = $('#toast-container');
const shortcutsHelp = $('#shortcuts-help');
const shortcutsClose = $('#shortcuts-close');

// ========== SEARCH ==========
let searchTimeout = null;
// Only search on Enter key press (not as-you-type to avoid rate limiting)

searchInput.addEventListener('input', (e) => {
    // Just clear empty state when typing
    if (!e.target.value.trim()) {
        showEmptyState();
    }
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimeout);
        performSearch(searchInput.value.trim());
        searchInput.blur();
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
        
        // Special handling for Favorites tab
        if (state.searchType === 'favorites') {
            renderPlaylistsView();
            return;
        }
        
        const query = searchInput.value.trim();
        if (query) performSearch(query);
    });
});

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

function addToPlaylist(playlistId, track) {
    const playlist = state.playlists.find(p => p.id === playlistId);
    if (!playlist) return;
    
    // Avoid duplicates
    if (playlist.tracks.some(t => t.id === track.id)) {
        showToast('Track already in playlist');
        return;
    }
    
    playlist.tracks.push({
        id: track.id,
        name: track.name,
        artists: track.artists,
        album: track.album || '',
        album_art: track.album_art || track.image || '/static/icon.svg',
        isrc: track.isrc || track.id,
        duration: track.duration || '0:00'
    });
    savePlaylists();
    showToast(`Added to "${playlist.name}"`);
}

function deletePlaylist(playlistId) {
    state.playlists = state.playlists.filter(p => p.id !== playlistId);
    savePlaylists();
    showToast('Playlist deleted');
    renderPlaylistsView();
}

function renderPlaylistsView() {
    hideLoading();
    
    if (state.playlists.length === 0) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">❤️</span>
                <p>No saved playlists yet</p>
                <p style="font-size: 0.9em; opacity: 0.7;">Import a Spotify playlist and click "Save to Favorites"</p>
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
    
    resultsContainer.innerHTML = '';
    resultsContainer.appendChild(grid);
    
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

function showPlaylistDetail(playlist) {
    // Reuse the existing detail view
    const albumData = {
        id: playlist.id,
        name: playlist.name,
        artists: `${playlist.tracks.length} tracks`,
        image: playlist.tracks[0]?.album_art || '/static/icon.svg',
        is_playlist: true
    };
    showDetailView(albumData, playlist.tracks);
}

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
    
    const grid = document.createElement('div');
    grid.className = 'results-grid';
    
    // For 'podcast' we reuse album card style
    if (type === 'podcast') {
        results.forEach(item => {
            // Ensure compatibility (podcasts look like albums)
            grid.innerHTML += renderAlbumCard(item);
        });
    } else if (type === 'track') {
        results.forEach(track => {
            grid.innerHTML += renderTrackCard(track);
        });
    } else if (type === 'album') {
        results.forEach(album => {
            grid.innerHTML += renderAlbumCard(album);
        });
    } else if (type === 'artist') {
        results.forEach(artist => {
            grid.innerHTML += renderArtistCard(artist);
        });
    }
    
    resultsContainer.innerHTML = '';
    resultsContainer.appendChild(grid);
    
    // Attach click listeners
    if (type === 'track') {
        grid.querySelectorAll('.track-item').forEach((el, i) => {
            el.addEventListener('click', () => playTrack(results[i]));
        });
    } else if (type === 'album' || type === 'podcast') {
        const items = grid.querySelectorAll('.album-item');
        items.forEach((el, i) => {
            el.addEventListener('click', () => openAlbum(results[i].id));
        });
    } else if (type === 'artist') {
        grid.querySelectorAll('.artist-item').forEach((el, i) => {
            el.addEventListener('click', () => openArtist(results[i].id));
        });
    }
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
    
    downloadTrackName.textContent = `${track.name} - ${track.artists}`;
    downloadModal.classList.remove('hidden');
};

if (downloadAllBtn) {
    downloadAllBtn.addEventListener('click', () => {
        if (state.detailTracks.length === 0) return;
        
        isBatchDownload = true;
        trackToDownload = null;
        
        // Get album/playlist name
        const name = $('.detail-name').textContent;
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
    downloadModal.classList.remove('hidden');
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
}

downloadCancelBtn.addEventListener('click', closeDownloadModal);

downloadConfirmBtn.addEventListener('click', async () => {
    const format = downloadFormat.value;
    const track = trackToDownload; // Capture before closing modal clears it
    const isBatch = isBatchDownload;
    
    closeDownloadModal();
    
    if (isBatch) {
        // Batch Download Logic
        const tracks = state.detailTracks;
        // ... (rest of batch logic)
        const name = $('.detail-name').textContent || 'Batch Download';
        const artist = $('.detail-artist').textContent;
        const albumName = artist ? `${artist} - ${name}` : name;
        
        showLoading(`Preparing ZIP for "${albumName}" (${tracks.length} tracks)...`);
        
        try {
            const response = await fetch('/api/download-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tracks: tracks.map(t => t.isrc || t.id),
                    names: tracks.map(t => t.name),
                    artists: tracks.map(t => t.artists),
                    album_name: albumName,
                    format: format
                })
            });
            
            if (!response.ok) throw new Error('Batch download failed');
            
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `${albumName}.zip`.replace(/[\\/:"*?<>|]/g, "_");
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            
            hideLoading();
            showToast('Batch download started!');
            
        } catch (error) {
            console.error('Batch download error:', error);
            hideLoading();
            showError('Failed to create ZIP. Please try again.');
        }
        return;
    }

    if (!track) return;
    
    // Single Track Logic using captured track variable
    showLoading(`Downloading "${track.name}" as ${format.toUpperCase()}...`);
    
    try {
        const query = `${track.name} ${track.artists}`;
        const isrc = track.isrc || track.id; 
        
        const filename = `${track.name} - ${track.artists}.${format === 'alac' ? 'm4a' : format}`.replace(/[\\/:"*?<>|]/g, "_");
        
        const response = await fetch(`/api/download/${isrc}?q=${encodeURIComponent(query)}&format=${format}&filename=${encodeURIComponent(filename)}`);
        
        if (!response.ok) throw new Error('Download failed');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        
        hideLoading();
        showToast('Download started!');
        
    } catch (error) {
        console.error('Download error:', error);
        hideLoading();
        showError('Failed to download track.');
    }
});
        


function renderTrackCard(track) {
    return `
        <div class="track-item" data-id="${track.id}">
            <img class="track-album-art" src="${track.album_art || '/static/icon.svg'}" alt="Album art" loading="lazy">
            <div class="track-info">
                <p class="track-name">${escapeHtml(track.name)}</p>
                <p class="track-artist">${escapeHtml(track.artists)}</p>
            </div>
            
            <div class="track-actions">
                <span class="track-duration">${track.duration}</span>
                <button class="download-btn" title="Download" onclick="event.stopPropagation(); openDownloadModal('${encodeURIComponent(JSON.stringify(track))}')">
                    ⬇
                </button>
            </div>
        </div>
    `;
}

// ... (keep renderAlbumCard and renderArtistCard as is) ...

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

// Updated showDetailView to handle downloads
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
    
    // Render tracks with download button
    detailTracks.innerHTML = tracks.map((t, i) => `
        <div class="track-item" data-index="${i}">
            <img class="track-album-art" src="${t.album_art || image}" alt="Art" loading="lazy">
            <div class="track-info">
                <p class="track-name">${escapeHtml(t.name)}</p>
                <p class="track-artist">${escapeHtml(t.artists)}</p>
            </div>
            
            <div class="track-actions">
                <span class="track-duration">${t.duration}</span>
                <button class="download-btn" title="Download" onclick="event.stopPropagation(); openDownloadModal('${encodeURIComponent(JSON.stringify(t))}')">
                    ⬇
                </button>
            </div>
        </div>
    `).join('');
    
    // Add click handlers for playing
    $$('#detail-tracks .track-item').forEach((el, i) => {
        el.addEventListener('click', (e) => {
            // Don't play if clicking download button (already handled by stopPropagation but safer)
            if (e.target.closest('.download-btn')) return;
            playTrack(tracks[i]);
        });
    });
    
    // Show detail view
    detailView.classList.remove('hidden');
    resultsSection.classList.add('hidden');
}

// ========== DOWNLOAD LOGIC ==========

window.openDownloadModal = function(trackJson) {
    const track = JSON.parse(decodeURIComponent(trackJson));
    trackToDownload = track;
    
    downloadTrackName.textContent = `${track.name} - ${track.artists}`;
    downloadModal.classList.remove('hidden');
};

function closeDownloadModal() {
    downloadModal.classList.add('hidden');
    trackToDownload = null;
}

downloadCancelBtn.addEventListener('click', closeDownloadModal);

downloadConfirmBtn.addEventListener('click', async () => {
    if (!trackToDownload) return;
    
    const format = downloadFormat.value;
    const track = trackToDownload;
    
    closeDownloadModal();
    
    // Show non-blocking notification or toast could be better, but we'll use loading for now
    // or just let it happen in background. Let's show a loading indicator.
    showLoading(`Downloading "${track.name}" as ${format.toUpperCase()}...`);
    
    try {
        const query = `${track.name} ${track.artists}`;
        const isrc = track.isrc || track.id; // Fallback to ID if ISRC missing
        
        // Construct filename
        const filename = `${track.artists} - ${track.name}.${format === 'alac' ? 'm4a' : format}`.replace(/[\\/:"*?<>|]/g, "_");
        
        const response = await fetch(`/api/download/${isrc}?q=${encodeURIComponent(query)}&format=${format}&filename=${encodeURIComponent(filename)}`);
        
        if (!response.ok) throw new Error('Download failed');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        
        hideLoading();
        
    } catch (error) {
        console.error('Download error:', error);
        showError('Failed to download track. Please try again.');
    }
});

// Close modal on outside click
downloadModal.addEventListener('click', (e) => {
    if (e.target === downloadModal) closeDownloadModal();
});

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
        case 'Escape':
            if (!downloadModal.classList.contains('hidden')) {
                closeDownloadModal();
            } else if (!detailView.classList.contains('hidden')) {
                hideDetailView();
            }
            break;
    }
});

// ========== SERVICE WORKER ==========
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
}

// Initial state
showEmptyState();


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
    
    // Check if this is already a saved playlist (to avoid re-saving)
    const isSavedPlaylist = item.id && item.id.startsWith('playlist_');
    
    detailInfo.innerHTML = `
        <img class="detail-art${isArtist ? ' artist-art' : ''}" src="${image}" alt="Cover">
        <div class="detail-meta">
            <p class="detail-name">${escapeHtml(item.name)}</p>
            <p class="detail-artist">${escapeHtml(subtitle)}</p>
            <p class="detail-stats">${stats}</p>
            ${!isSavedPlaylist && tracks.length > 0 ? `<button id="save-playlist-btn" class="save-playlist-btn">❤️ Save to Favorites</button>` : ''}
        </div>
    `;
    
    // Add save playlist handler
    const saveBtn = $('#save-playlist-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const name = prompt('Enter playlist name:', item.name || 'My Playlist');
            if (name) {
                createPlaylist(name, state.detailTracks);
            }
        });
    }
    
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

// Shuffle & Play button
shuffleBtn.addEventListener('click', () => {
    if (state.detailTracks.length === 0) return;
    
    // Copy and shuffle tracks using Fisher-Yates
    const shuffled = [...state.detailTracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    // Clear queue and add shuffled tracks
    state.queue = [];
    shuffled.forEach(track => state.queue.push(track));
    
    // Start playing first shuffled track
    state.currentIndex = 0;
    updateQueueUI();
    loadTrack(state.queue[0]);
    
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
    
    updateMediaSession(track);
    updateQueueUI();
    updateFullscreenUI(track); // Sync FS
    
    // Play
    audioPlayer.src = `/api/stream/${track.isrc || track.id}?q=${encodeURIComponent(track.name + ' ' + track.artists)}`;
    
    try {
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

audioPlayer.addEventListener('progress', () => {
    if (audioPlayer.duration > 0 && audioPlayer.buffered.length > 0) {
        // Check if we have buffered enough to start next download
        const bufferedEnd = audioPlayer.buffered.end(audioPlayer.buffered.length - 1);
        if (bufferedEnd >= audioPlayer.duration - 15) { // 15 seconds before end or fully buffered
             preloadNextTrack();
        }
    }
});

audioPlayer.addEventListener('timeupdate', () => {
    if (audioPlayer.duration) {
        currentTime.textContent = formatTime(audioPlayer.currentTime);
        duration.textContent = formatTime(audioPlayer.duration);
        progressBar.value = (audioPlayer.currentTime / audioPlayer.duration) * 100;
        
        // Sync FS Progress
        fsCurrentTime.textContent = currentTime.textContent;
        fsDuration.textContent = duration.textContent;
        fsProgressBar.value = progressBar.value;
    }
});

progressBar.addEventListener('input', (e) => {
    if (audioPlayer.duration) {
        audioPlayer.currentTime = (e.target.value / 100) * audioPlayer.duration;
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

// Delegated click handler for queue items (handles both play and remove)
queueContainer.addEventListener('click', (e) => {
    // Check if clicked on remove button
    const removeBtn = e.target.closest('.queue-remove-btn');
    if (removeBtn) {
        e.stopPropagation();
        const index = parseInt(removeBtn.dataset.index, 10);
        window.removeFromQueue(index);
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

function updateQueueUI() {
    queueCount.textContent = `(${state.queue.length})`;
    
    if (state.queue.length === 0) {
        queueContainer.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);padding:24px;">Queue is empty</p>';
        return;
    }
    
    queueContainer.innerHTML = state.queue.map((track, i) => `
        <div class="queue-item" data-index="${i}">
            <img class="track-album-art" src="${track.album_art || '/static/icon.svg'}" alt="Art" style="width:40px;height:40px;">
            <div class="track-info">
                <p class="track-name" style="font-size:0.875rem;">${escapeHtml(track.name)}</p>
                <p class="track-artist">${escapeHtml(track.artists)}</p>
            </div>
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

function preloadNextTrack() {
    if (state.currentIndex === -1 || state.currentIndex >= state.queue.length - 1) return;
    
    const nextTrack = state.queue[state.currentIndex + 1];
    if (!nextTrack || nextTrack.id === preloadedTrackId) return;
    
    preloadedTrackId = nextTrack.id;
    console.log('Preloading next track:', nextTrack.name);
    
    const query = `${nextTrack.name} ${nextTrack.artists}`;
    const streamUrl = `/api/stream/${nextTrack.isrc || nextTrack.id}?q=${encodeURIComponent(query)}`;
    
    // Fetch to trigger backend cache and browser cache
    fetch(streamUrl).then(res => {
        if (res.ok) console.log('Preload started/cached');
    }).catch(e => console.error('Preload failed', e));
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

// ========== FULLSCREEN PLAYER & EXTRAS ==========

window.removeFromQueue = function(index) {
    if (index === state.currentIndex) {
        // Removing currently playing
        state.queue.splice(index, 1);
        if (state.queue.length === 0) {
            audioPlayer.pause();
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
    fsArtist.textContent = track.artists;
    fsArt.src = track.album_art || '/static/icon.svg';
    
    // Backdrop
    const backdrop = document.querySelector('.fs-backdrop');
    if (backdrop) backdrop.style.backgroundImage = `url('${track.album_art || '/static/icon.svg'}')`;
    
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
if (fsPrevBtn) fsPrevBtn.addEventListener('click', () => prevBtn.click());
if (fsNextBtn) fsNextBtn.addEventListener('click', () => nextBtn.click());

if (fsProgressBar) {
    fsProgressBar.addEventListener('input', (e) => {
        if (audioPlayer.duration) {
            audioPlayer.currentTime = (e.target.value / 100) * audioPlayer.duration;
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
volumeSlider.addEventListener('input', (e) => {
    const vol = e.target.value / 100;
    audioPlayer.volume = vol;
    state.volume = vol;
    state.muted = vol === 0;
    updateMuteIcon();
});

muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    if (state.muted) {
        audioPlayer.volume = 0;
        volumeSlider.value = 0;
    } else {
        audioPlayer.volume = state.volume || 1;
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

// Override playNext for repeat handling
const originalPlayNext = playNext;
window.playNextWithRepeat = function() {
    if (state.repeatMode === 'one') {
        audioPlayer.currentTime = 0;
        audioPlayer.play();
        return;
    }
    
    if (state.currentIndex < state.queue.length - 1) {
        state.currentIndex++;
        loadTrack(state.queue[state.currentIndex]);
    } else if (state.repeatMode === 'all' && state.queue.length > 0) {
        state.currentIndex = 0;
        loadTrack(state.queue[0]);
    }
};

// Replace ended handler with repeat-aware version
audioPlayer.removeEventListener('ended', playNext);
audioPlayer.addEventListener('ended', window.playNextWithRepeat);

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
                audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 10);
            } else {
                playNext();
            }
            break;
        case 'ArrowLeft':
            if (e.shiftKey) {
                audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 10);
            } else {
                playPrevious();
            }
            break;
        case 'ArrowUp':
            e.preventDefault();
            audioPlayer.volume = Math.min(1, audioPlayer.volume + 0.1);
            volumeSlider.value = audioPlayer.volume * 100;
            state.volume = audioPlayer.volume;
            updateMuteIcon();
            showToast(`Volume: ${Math.round(audioPlayer.volume * 100)}%`);
            break;
        case 'ArrowDown':
            e.preventDefault();
            audioPlayer.volume = Math.max(0, audioPlayer.volume - 0.1);
            volumeSlider.value = audioPlayer.volume * 100;
            state.volume = audioPlayer.volume;
            updateMuteIcon();
            showToast(`Volume: ${Math.round(audioPlayer.volume * 100)}%`);
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
