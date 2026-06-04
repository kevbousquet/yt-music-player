'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const BLOB_URL    = 'https://jsonblob.com/api/jsonBlob/019e928e-d683-702e-b2f7-cf31eb6b8313';
const CACHE_KEY   = 'ytplayer_cache_v2';
const PROFILE_KEY = 'ytplayer_profile';
const COLORS      = ['#7c6af7','#e94560','#4ade80','#f0c040','#60a5fa','#f97316','#a78bfa','#fb7185'];

let syncTimer = null;

// ── Cloud sync ────────────────────────────────────────────────────────────────
function setSyncStatus(s) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.className = `sync-dot sync-${s}`;
    el.title = { syncing:'Synchronisation…', synced:'Synchronisé ✓', error:'Erreur sync', offline:'Hors ligne' }[s] || '';
}

async function cloudSave(data) {
    setSyncStatus('syncing');
    try {
        const r = await fetch(BLOB_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(data),
        });
        setSyncStatus(r.ok ? 'synced' : 'error');
    } catch (_) { setSyncStatus('offline'); }
}

async function cloudLoad() {
    try {
        const r = await fetch(`${BLOB_URL}?t=${Date.now()}`, {
            headers: { 'Accept': 'application/json' }, cache: 'no-store',
        });
        if (r.ok) return await r.json();
    } catch (_) {}
    return null;
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    profiles:        {},    // { [id]: { id, name, color, playlists, activePlaylistId } }
    activeProfileId: null,
    trackIndex:      -1,
    isShuffled:      false,
    shuffleOrder:    [],
    shufflePos:      -1,
};

let ytPlayer    = null;
let playerReady = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function extractVideoId(url) {
    for (const re of [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /shorts\/([a-zA-Z0-9_-]{11})/,
        /embed\/([a-zA-Z0-9_-]{11})/,
    ]) { const m = url.match(re); if (m) return m[1]; }
    return null;
}

function activeProfile() { return state.profiles[state.activeProfileId] || null; }
function activePL() {
    const p = activeProfile();
    return p ? (p.playlists[p.activePlaylistId] || null) : null;
}

function shuffled(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ── Persistence ───────────────────────────────────────────────────────────────
function save() {
    const data = { version: 2, profiles: state.profiles };
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => cloudSave(data), 800);
}

// ── Migration v1 → v2 ─────────────────────────────────────────────────────────
function migrateV1(cloudData) {
    if (!cloudData?.playlists) return null;
    const id = uid();
    return {
        version: 2,
        profiles: {
            [id]: {
                id, name: 'Mon profil', color: COLORS[0],
                playlists: cloudData.playlists,
                activePlaylistId: cloudData.activePlaylistId || null,
            },
        },
    };
}

// ── Profile actions ───────────────────────────────────────────────────────────
function selectProfile(id) {
    if (!state.profiles[id]) return;
    state.activeProfileId = id;
    state.trackIndex      = -1;
    state.shuffleOrder    = [];
    state.shufflePos      = -1;
    localStorage.setItem(PROFILE_KEY, id);
    hideProfileScreen();
    render();
}

function createProfile(name) {
    if (!name.trim()) return;
    const id       = uid();
    const colorIdx = Object.keys(state.profiles).length % COLORS.length;
    const plId     = uid();
    state.profiles[id] = {
        id, name: name.trim(), color: COLORS[colorIdx],
        playlists: { [plId]: { id: plId, name: 'Ma playlist', tracks: [] } },
        activePlaylistId: plId,
    };
    save();
    selectProfile(id);
}

function deleteProfile(id) {
    if (Object.keys(state.profiles).length <= 1) {
        alert('Impossible de supprimer le seul profil existant.'); return;
    }
    if (!confirm(`Supprimer le profil "${state.profiles[id]?.name}" et toutes ses playlists ?`)) return;
    delete state.profiles[id];
    if (state.activeProfileId === id) {
        state.activeProfileId = null;
        localStorage.removeItem(PROFILE_KEY);
    }
    save();
    renderProfileScreen();
    if (!state.activeProfileId) showProfileScreen();
}

// ── Playlist actions ──────────────────────────────────────────────────────────
function newPlaylist(name) {
    const p = activeProfile(); if (!p) return;
    const id = uid();
    p.playlists[id] = { id, name, tracks: [] };
    p.activePlaylistId = id;
    save(); render();
}

function delPlaylist(id) {
    const p = activeProfile(); if (!p) return;
    if (!confirm(`Supprimer "${p.playlists[id]?.name}" ?`)) return;
    delete p.playlists[id];
    const ids = Object.keys(p.playlists);
    if (!ids.length) {
        const nid = uid();
        p.playlists[nid] = { id: nid, name: 'Ma playlist', tracks: [] };
        p.activePlaylistId = nid;
    } else { p.activePlaylistId = ids[0]; }
    save(); render();
}

function renamePlaylist(id, name) {
    const p = activeProfile(); if (!p || !name.trim()) return;
    p.playlists[id].name = name.trim();
    save(); renderPlaylists();
}

function switchPlaylist(id) {
    const p = activeProfile(); if (!p || id === p.activePlaylistId) return;
    p.activePlaylistId = id;
    state.trackIndex   = -1; state.shuffleOrder = []; state.shufflePos = -1;
    save(); render();
}

// ── Track actions ─────────────────────────────────────────────────────────────
function addTrack(rawUrl, customTitle) {
    const pl = activePL(); if (!pl) return;
    const vid = extractVideoId(rawUrl.trim());
    if (!vid) { alert('Lien YouTube non reconnu.\nEx: https://www.youtube.com/watch?v=…'); return; }
    const idx = pl.tracks.length;
    pl.tracks.push({ id: uid(), videoId: vid, title: customTitle.trim() || 'Chargement…' });
    if (state.isShuffled) resetShuffle(pl.tracks.length);
    save(); renderTracks();
    if (!customTitle.trim()) {
        const profId = state.activeProfileId;
        const plId   = activeProfile()?.activePlaylistId;
        fetchTitle(vid, profId, plId, idx);
    }
}

function fetchTitle(vid, profId, plId, idx) {
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(d => {
            const pl = state.profiles[profId]?.playlists[plId];
            if (!pl?.tracks[idx]) return;
            pl.tracks[idx].title = d.title;
            save(); renderTracks();
            if (state.activeProfileId === profId &&
                activeProfile()?.activePlaylistId === plId &&
                state.trackIndex === idx) renderNowPlaying();
        })
        .catch(() => {
            const pl = state.profiles[profId]?.playlists[plId];
            if (pl?.tracks[idx]?.title === 'Chargement…') {
                pl.tracks[idx].title = `Piste ${idx + 1}`;
                save(); renderTracks();
            }
        });
}

function delTrack(idx) {
    const pl = activePL(); if (!pl) return;
    pl.tracks.splice(idx, 1);
    if (state.trackIndex >= pl.tracks.length) state.trackIndex = pl.tracks.length - 1;
    if (state.isShuffled) resetShuffle(pl.tracks.length);
    save(); renderTracks();
}

function clearTracks() {
    const pl = activePL();
    if (!pl?.tracks.length || !confirm('Vider la playlist ?')) return;
    pl.tracks = []; state.trackIndex = -1; state.shuffleOrder = []; state.shufflePos = -1;
    save(); renderTracks(); renderNowPlaying();
}

// ── Playback ──────────────────────────────────────────────────────────────────
function playAt(realIdx) {
    const pl = activePL();
    if (!pl || realIdx < 0 || realIdx >= pl.tracks.length) return;
    state.trackIndex = realIdx;
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
        const n = (state.shufflePos + 1) % state.shuffleOrder.length;
        state.shufflePos = n; playAt(state.shuffleOrder[n]);
    } else { playAt((state.trackIndex + 1) % pl.tracks.length); }
}

function playPrev() {
    const pl = activePL(); if (!pl?.tracks.length) return;
    if (state.isShuffled && state.shuffleOrder.length) {
        const n = (state.shufflePos - 1 + state.shuffleOrder.length) % state.shuffleOrder.length;
        state.shufflePos = n; playAt(state.shuffleOrder[n]);
    } else { playAt(state.trackIndex <= 0 ? pl.tracks.length - 1 : state.trackIndex - 1); }
}

function togglePlayPause() {
    if (!playerReady || !ytPlayer) return;
    if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
    else { if (state.trackIndex < 0) playAt(0); else ytPlayer.playVideo(); }
}

function toggleShuffle() {
    const pl = activePL();
    state.isShuffled = !state.isShuffled;
    document.getElementById('btn-shuffle').classList.toggle('active', state.isShuffled);
    if (state.isShuffled && pl) {
        resetShuffle(pl.tracks.length);
        if (state.trackIndex >= 0) {
            const pos = state.shuffleOrder.indexOf(state.trackIndex);
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
function render() { renderProfileBadge(); renderPlaylists(); renderTracks(); renderNowPlaying(); }

function renderProfileBadge() {
    const btn = document.getElementById('profile-badge');
    const p   = activeProfile();
    if (!btn || !p) return;
    btn.textContent        = p.name[0].toUpperCase();
    btn.style.background   = p.color;
    btn.style.borderColor  = p.color;
    btn.title              = `Profil : ${p.name} — Cliquer pour changer`;
}

function renderPlaylists() {
    const p         = activeProfile();
    const container = document.getElementById('playlist-tabs');
    if (!p) { container.innerHTML = ''; return; }
    container.innerHTML = Object.values(p.playlists).map(pl => `
        <div class="playlist-tab ${pl.id === p.activePlaylistId ? 'active' : ''}" data-id="${pl.id}">
            <span class="tab-name" title="Double-clic pour renommer">${esc(pl.name)}</span>
            <button class="btn-del-pl" data-id="${pl.id}">&#xD7;</button>
        </div>`).join('');
    container.querySelectorAll('.playlist-tab').forEach(tab => {
        tab.addEventListener('click', e => { if (!e.target.classList.contains('btn-del-pl')) switchPlaylist(tab.dataset.id); });
        tab.querySelector('.tab-name').addEventListener('dblclick', () => {
            const id     = tab.dataset.id;
            const nameEl = tab.querySelector('.tab-name');
            const input  = document.createElement('input');
            input.className = 'tab-rename'; input.value = p.playlists[id]?.name || '';
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
        <div class="track-item ${i === state.trackIndex ? 'active' : ''}" data-idx="${i}">
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
    const pl      = activePL();
    const titleEl = document.getElementById('track-title');
    const metaEl  = document.getElementById('track-meta');
    if (!pl || state.trackIndex < 0 || !pl.tracks[state.trackIndex]) {
        titleEl.textContent = '–'; metaEl.textContent = ''; return;
    }
    const t = pl.tracks[state.trackIndex];
    titleEl.textContent = t.title;
    metaEl.textContent  = `Piste ${state.trackIndex + 1} / ${pl.tracks.length}  —  ${pl.name}`;
}

function setPlayBtn(playing) {
    document.getElementById('btn-play-pause').innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
}

// ── Profile screen ────────────────────────────────────────────────────────────
function showProfileScreen() {
    document.getElementById('profile-screen').style.display = 'flex';
    renderProfileScreen();
}

function hideProfileScreen() {
    document.getElementById('profile-screen').style.display = 'none';
}

function renderProfileScreen() {
    const list = document.getElementById('profile-list');
    list.innerHTML = Object.values(state.profiles).map(p => `
        <div class="profile-card" data-id="${p.id}">
            <div class="profile-avatar" style="background:${p.color}">${esc(p.name[0].toUpperCase())}</div>
            <div class="profile-name">${esc(p.name)}</div>
            <button class="btn-del-profile" data-id="${p.id}" title="Supprimer">&#xD7;</button>
        </div>`).join('');
    list.querySelectorAll('.profile-card').forEach(card => {
        card.addEventListener('click', e => { if (!e.target.classList.contains('btn-del-profile')) selectProfile(card.dataset.id); });
    });
    list.querySelectorAll('.btn-del-profile').forEach(btn => {
        btn.addEventListener('click', () => deleteProfile(btn.dataset.id));
    });
}

// ── YouTube Search (via Invidious) ────────────────────────────────────────────
const INVIDIOUS = [
    'https://inv.nadeko.net',
    'https://invidious.privacyredirect.com',
    'https://invidious.tiekoetter.com',
];

let searchDebounce = null;

function formatDuration(s) {
    if (!s) return '–';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
}

async function searchYT(query) {
    const el = document.getElementById('search-results');
    el.innerHTML = '<p class="empty search-loading">Recherche en cours…</p>';
    for (const host of INVIDIOUS) {
        try {
            const url = `${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,author,lengthSeconds`;
            const r   = await fetch(url, { signal: AbortSignal.timeout(6000) });
            if (!r.ok) continue;
            const data = await r.json();
            renderSearchResults(data);
            return;
        } catch (_) {}
    }
    el.innerHTML = '<p class="empty">Impossible de contacter YouTube.<br>Vérifiez votre connexion.</p>';
}

function renderSearchResults(results) {
    const el = document.getElementById('search-results');
    if (!results?.length) { el.innerHTML = '<p class="empty">Aucun résultat.</p>'; return; }
    el.innerHTML = results.slice(0, 15).map(v => `
        <div class="search-result">
            <img class="result-thumb" src="https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg" loading="lazy" alt="">
            <div class="result-info">
                <div class="result-title">${esc(v.title)}</div>
                <div class="result-meta">${esc(v.author)} · ${formatDuration(v.lengthSeconds)}</div>
            </div>
            <button class="btn-add-result" data-vid="${v.videoId}" data-title="${esc(v.title)}" title="Ajouter à la playlist">+</button>
        </div>`).join('');

    el.querySelectorAll('.btn-add-result').forEach(btn => {
        btn.addEventListener('click', () => {
            const pl = activePL(); if (!pl) return;
            pl.tracks.push({ id: uid(), videoId: btn.dataset.vid, title: btn.dataset.title });
            if (state.isShuffled) resetShuffle(pl.tracks.length);
            save(); renderTracks();
            btn.textContent = '✓';
            btn.classList.add('added');
            setTimeout(() => { btn.textContent = '+'; btn.classList.remove('added'); }, 1500);
        });
    });
}

function showSearchModal() {
    document.getElementById('search-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('search-input').focus(), 50);
}

function hideSearchModal() {
    document.getElementById('search-modal').style.display = 'none';
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').innerHTML = '<p class="empty">Tapez pour rechercher…</p>';
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

    // 1. Load data (cloud first, then local cache)
    let data = await cloudLoad();
    if (!data) {
        data = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        setSyncStatus(data ? 'offline' : 'offline');
    } else {
        setSyncStatus('synced');
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    }

    // 2. Migrate v1 → v2 if needed
    if (data && data.version !== 2) {
        data = migrateV1(data) || { version: 2, profiles: {} };
        cloudSave(data);
    }

    state.profiles = data?.profiles || {};

    // 3. Restore profile for this device
    const savedId = localStorage.getItem(PROFILE_KEY);
    if (savedId && state.profiles[savedId]) {
        selectProfile(savedId);
    } else {
        showProfileScreen();
    }

    // 4. Re-sync when coming back to the tab
    document.addEventListener('visibilitychange', async () => {
        if (document.hidden) return;
        const fresh = await cloudLoad();
        if (!fresh?.profiles) return;
        state.profiles = fresh.profiles;
        localStorage.setItem(CACHE_KEY, JSON.stringify(fresh));
        if (state.activeProfileId && !state.profiles[state.activeProfileId]) {
            state.activeProfileId = null; showProfileScreen();
        } else if (state.activeProfileId) { render(); }
        setSyncStatus('synced');
    });

    // ── Buttons ──
    document.getElementById('btn-add-profile').addEventListener('click', () => {
        const name = prompt('Prénom ou pseudo (ex : Evona, Ma femme…) :');
        if (name?.trim()) createProfile(name.trim());
    });

    document.getElementById('profile-badge').addEventListener('click', showProfileScreen);

    // ── Search ──
    document.getElementById('btn-search-open').addEventListener('click', showSearchModal);
    document.getElementById('btn-search-close').addEventListener('click', hideSearchModal);

    document.getElementById('search-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) hideSearchModal();
    });

    document.getElementById('search-input').addEventListener('input', e => {
        clearTimeout(searchDebounce);
        const q = e.target.value.trim();
        if (q.length < 2) {
            document.getElementById('search-results').innerHTML = '<p class="empty">Tapez pour rechercher…</p>';
            return;
        }
        searchDebounce = setTimeout(() => searchYT(q), 500);
    });

    document.getElementById('search-input').addEventListener('keydown', e => {
        if (e.key === 'Escape') hideSearchModal();
    });

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
