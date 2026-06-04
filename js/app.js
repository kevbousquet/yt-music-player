'use strict';

// ── Cloud sync ────────────────────────────────────────────────────────────────
const BLOB_ID  = '019e928e-d683-702e-b2f7-cf31eb6b8313';
const BLOB_URL = `https://jsonblob.com/api/jsonBlob/${BLOB_ID}`;
let syncTimer  = null;

function setSyncStatus(status) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.className = `sync-dot sync-${status}`;
    const labels = { syncing: 'Synchronisation…', synced: 'Synchronisé ✓', error: 'Erreur sync', offline: 'Hors ligne' };
    el.title = labels[status] || '';
}

async function cloudSave(data) {
    setSyncStatus('syncing');
    try {
        const res = await fetch(BLOB_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(data),
        });
        setSyncStatus(res.ok ? 'synced' : 'error');
    } catch (_) {
        setSyncStatus('offline');
    }
}

async function cloudLoad() {
    try {
        const res = await fetch(`${BLOB_URL}?t=${Date.now()}`, {
            headers: { 'Accept': 'application/json' },
            cache: 'no-store',
        });
        if (res.ok) return await res.json();
    } catch (_) {}
    return null;
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    playlists: {},
    activePlaylistId: null,
    currentTrackIndex: -1,
    isShuffled: false,
    shuffleOrder: [],
    shufflePos: -1,
};

let ytPlayer    = null;
let playerReady = false;

// ── Local storage (offline cache) ─────────────────────────────────────────────
const STORAGE_KEY = 'ytplayer_v1';

function localSave(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function localLoad() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { return null; }
}

function save() {
    const data = { playlists: state.playlists, activePlaylistId: state.activePlaylistId };
    localSave(data);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => cloudSave(data), 800);
}

function applyData(data) {
    if (!data?.playlists) return false;
    state.playlists        = data.playlists;
    state.activePlaylistId = data.activePlaylistId || null;
    return true;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractVideoId(url) {
    for (const re of [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /shorts\/([a-zA-Z0-9_-]{11})/,
        /embed\/([a-zA-Z0-9_-]{11})/,
    ]) {
        const m = url.match(re); if (m) return m[1];
    }
    return null;
}

function activePL() { return state.playlists[state.activePlaylistId] || null; }

function shuffled(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ── Playlist CRUD ─────────────────────────────────────────────────────────────
function newPlaylist(name) {
    const id = uid();
    state.playlists[id] = { id, name, tracks: [] };
    state.activePlaylistId = id;
    save(); render();
}

function delPlaylist(id) {
    const pl = state.playlists[id];
    if (!pl || !confirm(`Supprimer "${pl.name}" ?`)) return;
    delete state.playlists[id];
    const ids = Object.keys(state.playlists);
    if (!ids.length) { newPlaylist('Ma playlist'); return; }
    state.activePlaylistId = ids[0];
    save(); render();
}

function renamePlaylist(id, name) {
    if (!name.trim() || !state.playlists[id]) return;
    state.playlists[id].name = name.trim();
    save(); renderPlaylists();
}

function switchPlaylist(id) {
    if (id === state.activePlaylistId) return;
    state.activePlaylistId  = id;
    state.currentTrackIndex = -1;
    state.shuffleOrder      = [];
    state.shufflePos        = -1;
    save(); render();
}

// ── Track CRUD ────────────────────────────────────────────────────────────────
function addTrack(rawUrl, customTitle) {
    const pl  = activePL(); if (!pl) return;
    const vid = extractVideoId(rawUrl.trim());
    if (!vid) { alert('Lien YouTube non reconnu.\nEx: https://www.youtube.com/watch?v=…'); return; }
    const idx = pl.tracks.length;
    pl.tracks.push({ id: uid(), videoId: vid, title: customTitle.trim() || 'Chargement…' });
    if (state.isShuffled) resetShuffle(pl.tracks.length);
    save(); renderTracks();
    if (!customTitle.trim()) fetchTitle(vid, state.activePlaylistId, idx);
}

function fetchTitle(vid, plId, idx) {
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(d => {
            const pl = state.playlists[plId];
            if (!pl?.tracks[idx]) return;
            pl.tracks[idx].title = d.title;
            save(); renderTracks();
            if (state.activePlaylistId === plId && state.currentTrackIndex === idx) renderNowPlaying();
        })
        .catch(() => {
            const pl = state.playlists[plId];
            if (pl?.tracks[idx]?.title === 'Chargement…') {
                pl.tracks[idx].title = `Piste ${idx + 1}`;
                save(); renderTracks();
            }
        });
}

function delTrack(idx) {
    const pl = activePL(); if (!pl) return;
    pl.tracks.splice(idx, 1);
    if (state.currentTrackIndex >= pl.tracks.length) state.currentTrackIndex = pl.tracks.length - 1;
    if (state.isShuffled) resetShuffle(pl.tracks.length);
    save(); renderTracks();
}

function clearTracks() {
    const pl = activePL();
    if (!pl?.tracks.length || !confirm('Vider la playlist ?')) return;
    pl.tracks = [];
    state.currentTrackIndex = -1; state.shuffleOrder = []; state.shufflePos = -1;
    save(); renderTracks(); renderNowPlaying();
}

// ── Playback ──────────────────────────────────────────────────────────────────
function playAt(realIdx) {
    const pl = activePL();
    if (!pl || realIdx < 0 || realIdx >= pl.tracks.length) return;
    state.currentTrackIndex = realIdx;
    if (state.isShuffled) {
        const pos = state.shuffleOrder.indexOf(realIdx);
        state.shufflePos = pos !== -1 ? pos : 0;
    }
    if (playerReady && ytPlayer) {
        ytPlayer.loadVideoById(pl.tracks[realIdx].videoId);
        document.getElementById('player-placeholder').style.display = 'none';
    }
    renderNowPlaying(); renderTracks();
}

function playNext() {
    const pl = activePL(); if (!pl?.tracks.length) return;
    if (state.isShuffled && state.shuffleOrder.length) {
        const next = (state.shufflePos + 1) % state.shuffleOrder.length;
        state.shufflePos = next; playAt(state.shuffleOrder[next]);
    } else {
        playAt((state.currentTrackIndex + 1) % pl.tracks.length);
    }
}

function playPrev() {
    const pl = activePL(); if (!pl?.tracks.length) return;
    if (state.isShuffled && state.shuffleOrder.length) {
        const prev = (state.shufflePos - 1 + state.shuffleOrder.length) % state.shuffleOrder.length;
        state.shufflePos = prev; playAt(state.shuffleOrder[prev]);
    } else {
        const prev = state.currentTrackIndex <= 0 ? pl.tracks.length - 1 : state.currentTrackIndex - 1;
        playAt(prev);
    }
}

function togglePlayPause() {
    if (!playerReady || !ytPlayer) return;
    const ps = ytPlayer.getPlayerState();
    if (ps === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
    else { if (state.currentTrackIndex < 0) playAt(0); else ytPlayer.playVideo(); }
}

function toggleShuffle() {
    const pl = activePL();
    state.isShuffled = !state.isShuffled;
    document.getElementById('btn-shuffle').classList.toggle('active', state.isShuffled);
    if (state.isShuffled && pl) {
        resetShuffle(pl.tracks.length);
        if (state.currentTrackIndex >= 0) {
            const pos = state.shuffleOrder.indexOf(state.currentTrackIndex);
            if (pos > 0) [state.shuffleOrder[0], state.shuffleOrder[pos]] = [state.shuffleOrder[pos], state.shuffleOrder[0]];
            state.shufflePos = 0;
        }
    } else { state.shuffleOrder = []; state.shufflePos = -1; }
}

function resetShuffle(length) {
    state.shuffleOrder = shuffled(Array.from({ length }, (_, i) => i));
    state.shufflePos   = 0;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() { renderPlaylists(); renderTracks(); renderNowPlaying(); }

function renderPlaylists() {
    const container = document.getElementById('playlist-tabs');
    container.innerHTML = Object.values(state.playlists).map(pl => `
        <div class="playlist-tab ${pl.id === state.activePlaylistId ? 'active' : ''}" data-id="${pl.id}">
            <span class="tab-name" title="Double-clic pour renommer">${esc(pl.name)}</span>
            <button class="btn-del-pl" data-id="${pl.id}">&#xD7;</button>
        </div>`).join('');

    container.querySelectorAll('.playlist-tab').forEach(tab => {
        tab.addEventListener('click', e => { if (!e.target.classList.contains('btn-del-pl')) switchPlaylist(tab.dataset.id); });
        tab.querySelector('.tab-name').addEventListener('dblclick', () => {
            const id = tab.dataset.id;
            const nameEl = tab.querySelector('.tab-name');
            const input  = document.createElement('input');
            input.className = 'tab-rename'; input.value = state.playlists[id]?.name || '';
            nameEl.replaceWith(input); input.focus(); input.select();
            const done = () => renamePlaylist(id, input.value);
            input.addEventListener('blur', done);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') renderPlaylists(); });
        });
    });
    container.querySelectorAll('.btn-del-pl').forEach(btn => btn.addEventListener('click', () => delPlaylist(btn.dataset.id)));
}

function renderTracks() {
    const pl = activePL();
    const el = document.getElementById('track-list');
    if (!pl?.tracks.length) { el.innerHTML = '<p class="empty">Aucune piste — collez un lien YouTube ci-dessous.</p>'; return; }
    el.innerHTML = pl.tracks.map((t, i) => `
        <div class="track-item ${i === state.currentTrackIndex ? 'active' : ''}" data-idx="${i}">
            <span class="t-num">${i + 1}</span>
            <span class="t-name" title="${esc(t.title)}">${esc(t.title)}</span>
            <button class="btn-del-t" data-idx="${i}">&#xD7;</button>
        </div>`).join('');
    el.querySelectorAll('.track-item').forEach(item => item.addEventListener('click', e => { if (!e.target.classList.contains('btn-del-t')) playAt(+item.dataset.idx); }));
    el.querySelectorAll('.btn-del-t').forEach(btn => btn.addEventListener('click', () => delTrack(+btn.dataset.idx)));
    const active = el.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

function renderNowPlaying() {
    const pl = activePL();
    const titleEl = document.getElementById('track-title');
    const metaEl  = document.getElementById('track-meta');
    if (!pl || state.currentTrackIndex < 0 || !pl.tracks[state.currentTrackIndex]) {
        titleEl.textContent = '–'; metaEl.textContent = ''; return;
    }
    const t = pl.tracks[state.currentTrackIndex];
    titleEl.textContent = t.title;
    metaEl.textContent  = `Piste ${state.currentTrackIndex + 1} / ${pl.tracks.length}  —  ${pl.name}`;
}

function setPlayBtn(playing) {
    document.getElementById('btn-play-pause').innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
}

// ── YouTube IFrame API ────────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('yt-player', {
        height: '200', width: '100%',
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
        events: {
            onReady()        { playerReady = true; },
            onStateChange(e) {
                if (e.data === YT.PlayerState.ENDED) playNext();
                setPlayBtn(e.data === YT.PlayerState.PLAYING);
            },
            onError()        { setTimeout(playNext, 1500); },
        },
    });
};

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    setSyncStatus('syncing');

    // Load from cloud first, fall back to localStorage
    const cloudData = await cloudLoad();
    if (cloudData?.playlists && Object.keys(cloudData.playlists).length) {
        applyData(cloudData);
        localSave(cloudData);
        setSyncStatus('synced');
    } else {
        const local = localLoad();
        applyData(local);
        setSyncStatus(cloudData === null ? 'offline' : 'synced');
    }

    // Ensure valid state
    if (!Object.keys(state.playlists).length) {
        newPlaylist('Ma playlist'); // calls save() + render()
    } else {
        if (!state.activePlaylistId || !state.playlists[state.activePlaylistId]) {
            state.activePlaylistId = Object.keys(state.playlists)[0];
        }
        render();
    }

    // Re-sync when user comes back to the tab
    document.addEventListener('visibilitychange', async () => {
        if (document.hidden) return;
        const data = await cloudLoad();
        if (!data?.playlists) return;
        applyData(data);
        if (!state.playlists[state.activePlaylistId]) {
            state.activePlaylistId = Object.keys(state.playlists)[0] || null;
        }
        render();
        setSyncStatus('synced');
    });

    // ── Buttons ──
    document.getElementById('btn-new-playlist').addEventListener('click', () => {
        const name = prompt('Nom de la nouvelle playlist :');
        if (name?.trim()) newPlaylist(name.trim());
    });

    document.getElementById('btn-add').addEventListener('click', () => {
        const url   = document.getElementById('url-input').value;
        const title = document.getElementById('title-input').value;
        if (!url.trim()) { document.getElementById('url-input').focus(); return; }
        addTrack(url, title);
        document.getElementById('url-input').value  = '';
        document.getElementById('title-input').value = '';
        document.getElementById('url-input').focus();
    });

    document.getElementById('url-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('btn-add').click();
    });

    document.getElementById('btn-play-pause').addEventListener('click', togglePlayPause);
    document.getElementById('btn-next').addEventListener('click', playNext);
    document.getElementById('btn-prev').addEventListener('click', playPrev);
    document.getElementById('btn-shuffle').addEventListener('click', toggleShuffle);
    document.getElementById('btn-clear').addEventListener('click', clearTracks);

    document.addEventListener('keydown', e => {
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (e.code === 'Space')      { e.preventDefault(); togglePlayPause(); }
        if (e.code === 'ArrowRight') playNext();
        if (e.code === 'ArrowLeft')  playPrev();
    });
});
