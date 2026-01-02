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

// App.js v0101X

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
        // Fetch features regarding DJ Mode
        if (state.djMode) {
            fetchAudioFeaturesForTracks(results);
        }
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
    const year = track.release_date ? track.release_date.slice(0, 4) : '';
    const artistYear = year ? `${escapeHtml(track.artists)} • ${year}` : escapeHtml(track.artists);
    return `
        <div class="track-item" data-id="${track.id}">
            <img class="track-album-art" src="${track.album_art || '/static/icon.svg'}" alt="Album art" loading="lazy">
            <div class="track-info">
                <p class="track-name">${escapeHtml(track.name)}</p>
                <p class="track-artist">${artistYear}</p>
            </div>
            
            <div class="track-actions">
                ${renderDJBadgeForTrack(track)}
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
                ${renderDJBadgeForTrack(t)}
                <span class="track-duration">${t.duration}</span>
                ${t.source === 'podcast' ? `
                <button class="info-btn" title="Episode Details" onclick="event.stopPropagation(); showPodcastModal('${encodeURIComponent(JSON.stringify(t))}')">ℹ️</button>
                ` : ''}
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
    
    if (state.djMode && tracks.length > 0) {
        fetchAudioFeaturesForTracks(tracks);
    }
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

// Configure Save to Drive button
$('#download-drive-btn').addEventListener('click', async () => {
    if (!trackToDownload) return;
    
    // Ensure signed in logic 
    if (!googleAccessToken) {
        await signInWithGoogle();
        if (!googleAccessToken) return; // User cancelled or failed
    }

    const format = downloadFormat.value;
    const track = trackToDownload;
    
    closeDownloadModal();
    
    showLoading(`Saving "${track.name}" to Google Drive (as ${format.toUpperCase()})...`);
    
    try {
        // 1. Get Folder ID
        const folderId = await findOrCreateFreedifyFolder();
        if (!folderId) throw new Error('Could not find or create "Freedify" folder');
        
        // 2. Call Backend to Upload
        const query = `${track.name} ${track.artists}`;
        const isrc = track.isrc || track.id;
        
        // Construct filename
        const filename = `${track.artists} - ${track.name}.${format === 'alac' ? 'm4a' : format}`.replace(/[\\/:"*?<>|]/g, "_");

        const response = await fetch('/api/drive/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                isrc: isrc,
                access_token: googleAccessToken,
                format: format,
                folder_id: folderId,
                filename: filename,
                q: query
            })
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Upload failed');
        }
        
        const result = await response.json();
        hideLoading();
        showToast(`✅ Saved to Drive: ${result.name}`);
        
    } catch (error) {
        console.error('Drive save error:', error);
        hideLoading();
        showError(`Failed to save to Drive: ${error.message}`);
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
        el.addEventListener('click', () => {
            const track = tracks[i];
            // Show podcast modal for podcast episodes, otherwise play directly
            if (track.source === 'podcast' && track.description) {
                showPodcastModal(track);
            } else {
                playTrack(track);
            }
        });
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

function updatePlayerUI() {
    if (state.currentIndex < 0 || !state.queue[state.currentIndex]) return;
    const track = state.queue[state.currentIndex];
    
    // Basic Info
    playerBar.classList.remove('hidden');
    playerTitle.textContent = track.name;
    const year = track.release_date ? track.release_date.slice(0, 4) : '';
    playerArtist.textContent = year ? `${track.artists} • ${year}` : track.artists;
    playerArt.src = track.album_art || '/static/icon.svg';

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

    updateMediaSession(track);
}

async function loadTrack(track) {
    showLoading(`Loading "${track.name}"...`);
    playerBar.classList.remove('hidden');
    
    playerBar.classList.remove('hidden');
    
    updatePlayerUI();
    updateQueueUI();
    updateFullscreenUI(track); // Sync FS
    
    // Play
    if (track.is_local && track.src) {
        audioPlayer.src = track.src;
    } else {
        audioPlayer.src = `/api/stream/${track.isrc || track.id}?q=${encodeURIComponent(track.name + ' ' + track.artists)}`;
    }
    
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
    // DJ Mode Info in Player
    const playerDJInfo = $('#player-dj-info');
    if (state.djMode && playerDJInfo) {
        const feat = state.audioFeaturesCache[track.id];
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
            // Try to fetch if missing
            fetchAudioFeaturesForQueue();
            playerDJInfo.classList.add('hidden');
        }
    } else if (playerDJInfo) {
        playerDJInfo.classList.add('hidden');
    }

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
if (fsPrevBtn) fsPrevBtn.addEventListener('click', () => prevBtn.click());

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
        sourceNode = audioContext.createMediaElementSource(audioPlayer);
        
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
        
        // Connect chain: source -> EQ filters -> bass boost -> volume boost -> destination
        let lastNode = sourceNode;
        eqFilters.forEach(filter => {
            lastNode.connect(filter);
            lastNode = filter;
        });
        lastNode.connect(bassBoostFilter);
        bassBoostFilter.connect(volumeBoostGain);
        volumeBoostGain.connect(audioContext.destination);
        
        eqConnected = true;
        
        // Load saved settings
        loadEqSettings();
        
        console.log('Equalizer initialized');
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
audioPlayer.addEventListener('play', () => {
    if (!audioContext) {
        initEqualizer();
    } else if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
});

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
        document.body.classList.remove('theme-purple', 'theme-blue', 'theme-green', 'theme-pink', 'theme-orange');
        
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
    
    navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name || 'Unknown Track',
        artist: track.artists || 'Unknown Artist',
        album: track.album || '',
        artwork: [
            { src: track.album_art || '/static/icon.svg', sizes: '512x512', type: 'image/png' }
        ]
    });
}

// Set up Media Session action handlers
if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => {
        audioPlayer.play();
    });
    
    navigator.mediaSession.setActionHandler('pause', () => {
        audioPlayer.pause();
    });
    
    navigator.mediaSession.setActionHandler('previoustrack', () => {
        playPrevious();
    });
    
    navigator.mediaSession.setActionHandler('nexttrack', () => {
        playNext();
    });
    
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        audioPlayer.currentTime = Math.max(audioPlayer.currentTime - (details.seekOffset || 10), 0);
    });
    
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
        audioPlayer.currentTime = Math.min(audioPlayer.currentTime + (details.seekOffset || 10), audioPlayer.duration);
    });
    
    navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.fastSeek && 'fastSeek' in audioPlayer) {
            audioPlayer.fastSeek(details.seekTime);
        } else {
            audioPlayer.currentTime = details.seekTime;
        }
    });
}

// Update position state periodically
audioPlayer.addEventListener('timeupdate', () => {
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
        try {
            if (audioPlayer.duration && !isNaN(audioPlayer.duration)) {
                navigator.mediaSession.setPositionState({
                    duration: audioPlayer.duration,
                    playbackRate: audioPlayer.playbackRate,
                    position: audioPlayer.currentTime
                });
            }
        } catch (e) { /* Ignore errors */ }
    }
});

// ========== GOOGLE DRIVE SYNC ==========
// NOTE: You need to set your Google OAuth Client ID here
const GOOGLE_CLIENT_ID = localStorage.getItem('freedify_google_client_id') || '';
// Expanded scope: appdata for favorites sync + drive.file for saving audio files
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
const SYNC_FILENAME = 'freedify_playlists.json';
const FREEDIFY_FOLDER_NAME = 'Freedify';

let googleAccessToken = null;
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

// Upload playlists to Drive
async function uploadToDrive() {
    if (!googleAccessToken) {
        await signInWithGoogle();
        if (!googleAccessToken) return;
    }
    
    showLoading('Syncing to Google Drive...');
    
    try {
        const playlistData = JSON.stringify(state.playlists, null, 2);
        const existingFile = await findSyncFile();
        
        const metadata = {
            name: SYNC_FILENAME,
            mimeType: 'application/json'
        };
        
        if (!existingFile) {
            metadata.parents = ['appDataFolder'];
        }
        
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', new Blob([playlistData], { type: 'application/json' }));
        
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
            showToast(`Synced ${state.playlists.length} playlist(s) to Google Drive`);
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

// Download playlists from Drive
async function downloadFromDrive() {
    if (!googleAccessToken) {
        await signInWithGoogle();
        if (!googleAccessToken) return;
    }
    
    showLoading('Loading from Google Drive...');
    
    try {
        const file = await findSyncFile();
        
        if (!file) {
            hideLoading();
            showToast('No saved playlists found in Drive');
            return;
        }
        
        const response = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
            { headers: { 'Authorization': `Bearer ${googleAccessToken}` } }
        );
        
        if (response.ok) {
            const playlists = await response.json();
            state.playlists = playlists;
            savePlaylists();
            hideLoading();
            showToast(`Loaded ${playlists.length} playlist(s) from Google Drive`);
            
            // Refresh view if on favorites tab
            if (state.searchType === 'favorites') {
                renderPlaylistsView();
            }
        } else {
            throw new Error('Download failed');
        }
    } catch (e) {
        console.error('Download error:', e);
        hideLoading();
        showError('Failed to load from Google Drive');
    }
}

// Sync button click handler
syncBtn?.addEventListener('click', async () => {
    await initGoogleApi();
    
    const action = confirm(
        'Google Drive Sync\n\n' +
        'OK = Upload playlists to Drive\n' +
        'Cancel = Download playlists from Drive'
    );
    
    if (action) {
        await uploadToDrive();
    } else {
        await downloadFromDrive();
    }
});

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

function showPodcastModal(track) {
    if (!track || track.source !== 'podcast') return;
    
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
