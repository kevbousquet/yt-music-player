'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const GITHUB_API       = 'https://api.github.com/repos/kevbousquet/yt-music-player/contents/db.json';
const CACHE_KEY        = 'ytplayer_cache_v2';
const PROFILE_KEY      = 'ytplayer_profile';
const TOKEN_KEY        = 'ytplayer_gh_token';
const YT_API_KEY_STORE = 'ytplayer_yt_api_key';
const DEFAULT_TOKEN    = '__SYNC_TOKEN__';
const DEFAULT_YT_KEY   = atob('QUl6YVN5QkJieHdZc2EzbGJlaEhNcUJYdUZ4Xzczazg1TFBmWHhr');
const WORKER_KEY       = 'ytplayer_worker_url';
const DEFAULT_WORKER   = 'https://yt-music.kevbousquetagenda.workers.dev';
const COLORS           = ['#7c6af7','#e94560','#4ade80','#f0c040','#60a5fa','#f97316','#a78bfa','#fb7185'];

let syncTimer        = null;
let pendingCloudSave = false;
let lastCloudSaveTime = 0;
let ghToken          = null;
let dbSha            = null;
let ytApiKey         = null;

// ── PWA : Service Worker + installation ──────────────────────────────────────
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/yt-music-player/sw.js').catch(() => {});
}

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const banner = document.getElementById('install-banner');
    if (banner) banner.style.display = 'flex';
});

window.addEventListener('appinstalled', () => {
    const banner = document.getElementById('install-banner');
    if (banner) banner.style.display = 'none';
});

// ── Cloud sync via GitHub API ─────────────────────────────────────────────────
function setSyncStatus(s) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.className = `sync-dot sync-${s}`;
    el.title = {
        syncing: 'Synchronisation…',
        synced:  'Synchronisé ✓',
        error:   'Erreur sync',
        offline: ghToken ? 'Hors ligne' : 'Sync non configurée — voir ⚙',
    }[s] || '';
}

function toB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin);
}
function fromB64(str) {
    const bin = atob(str.replace(/\n/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

async function cloudLoad(isRetry = false) {
    try {
        const headers = { Accept: 'application/vnd.github.v3+json' };
        if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
        const r = await fetch(`${GITHUB_API}?t=${Date.now()}`, { headers, cache: 'no-store' });
        // Token révoqué ou invalide : basculer sur le token injecté par CI
        if (!isRetry && r.status === 401 && ghToken && DEFAULT_TOKEN !== '__SYNC_TOKEN__') {
            localStorage.removeItem(TOKEN_KEY);
            ghToken = DEFAULT_TOKEN;
            localStorage.setItem(TOKEN_KEY, ghToken);
            return cloudLoad(true);
        }
        if (!r.ok) return null;
        const json = await r.json();
        dbSha = json.sha;
        return JSON.parse(fromB64(json.content));
    } catch (_) { return null; }
}

// Fusionne : ajoute les pistes du cloud absentes en local, sauf celles supprimées (tombstones)
function mergeData(local, cloud) {
    const merged = JSON.parse(JSON.stringify(local));
    for (const [pid, cProf] of Object.entries(cloud.profiles || {})) {
        if (!merged.profiles[pid]) { merged.profiles[pid] = cProf; continue; }
        for (const [plid, cPl] of Object.entries(cProf.playlists || {})) {
            if (!merged.profiles[pid].playlists[plid]) {
                merged.profiles[pid].playlists[plid] = cPl; continue;
            }
            const lPl      = merged.profiles[pid].playlists[plid];
            const existing = new Set(lPl.tracks.map(t => t.videoId));
            const deleted  = new Set(lPl.deletedVideoIds || []); // tombstones
            for (const t of cPl.tracks) {
                if (!existing.has(t.videoId) && !deleted.has(t.videoId)) {
                    lPl.tracks.push(t); existing.add(t.videoId);
                }
            }
        }
    }
    merged.lastModified = Date.now();
    return merged;
}

async function cloudSave(data) {
    syncTimer = null;
    if (!ghToken) { pendingCloudSave = false; setSyncStatus('offline'); return; }
    setSyncStatus('syncing');
    if (!dbSha) await cloudLoad(); // récupère le SHA sans merger
    try {
        const r = await fetch(GITHUB_API, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${ghToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/vnd.github.v3+json',
            },
            body: JSON.stringify({
                message: 'Sync playlists',
                content: toB64(JSON.stringify(data)),
                sha: dbSha,
            }),
        });
        if (r.ok) {
            dbSha = (await r.json()).content.sha;
            lastCloudSaveTime = Date.now();
            pendingCloudSave = false;
            setSyncStatus('synced');
        } else if (r.status === 409) {
            // Conflit SHA : nouveau SHA sans merger, puis réessayer
            await cloudLoad();
            await cloudSave(data);
        } else if (r.status === 401 && DEFAULT_TOKEN !== '__SYNC_TOKEN__' && ghToken !== DEFAULT_TOKEN) {
            localStorage.removeItem(TOKEN_KEY);
            ghToken = DEFAULT_TOKEN;
            localStorage.setItem(TOKEN_KEY, ghToken);
            await cloudSave(data);
        } else {
            pendingCloudSave = false;
            setSyncStatus('error');
        }
    } catch (_) { pendingCloudSave = false; setSyncStatus('offline'); }
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

// ── État player ───────────────────────────────────────────────────────────────
let isPlaying      = false;
let autoNextTimer  = null;
let timerStartedAt = null; // Date.now() au démarrage du timer
let elapsedMs      = 0;    // ms déjà jouées avant la dernière pause
let currentDurMs   = 0;    // durée totale en ms

// ── Background ────────────────────────────────────────────────────────────────
let wasPlayingOnHide     = false;
let isInBackground       = false;
let bgCheckInterval      = null;

// ── Repeat & progress ─────────────────────────────────────────────────────────
let repeatMode      = 0; // 0=off 1=all 2=one
let progressInterval = null;

// ── Filtre playlist ───────────────────────────────────────────────────────────
let trackFilter = '';

// ── Volume ────────────────────────────────────────────────────────────────────
let currentVolume = parseInt(localStorage.getItem('ytplayer_volume') || '80');
let prevVolume    = currentVolume || 80;

// ── Sleep timer ───────────────────────────────────────────────────────────────
let sleepTimerEnd      = null;
let sleepTimerInterval = null;
let sleepTimerMins     = 0;
const SLEEP_PRESETS    = [0, 15, 30, 60];

// ── Auto-scroll flag ──────────────────────────────────────────────────────────
let shouldScrollToActive = false;

// ── Silent-audio keepalive (maintient la session audio pour l'arrière-plan) ──
const keepAliveEl = new Audio();
keepAliveEl.loop  = true;
keepAliveEl.volume = 0.001; // quasi-inaudible mais non nul

function initKeepAliveAudio() {
    if (keepAliveEl.src) return;
    try {
        const sr = 8000, ns = sr >> 1; // 0.5 s
        const buf = new ArrayBuffer(44 + ns);
        const v   = new DataView(buf);
        const s   = (x, o) => v.setUint32(o, x, false);
        s(0x52494646, 0); v.setUint32(4, 36 + ns, true); s(0x57415645, 8);
        s(0x666d7420, 12); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
        v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr, true);
        v.setUint16(32, 1, true); v.setUint16(34, 8, true);
        s(0x64617461, 36); v.setUint32(40, ns, true);
        new Uint8Array(buf, 44).fill(0x80);
        keepAliveEl.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    } catch (_) {}
}

function startKeepAlive() {
    if (useNativeAudio) return;
    initKeepAliveAudio();
    keepAliveEl.play().catch(() => {});
}

function stopKeepAlive() {
    keepAliveEl.pause();
}

// ── Volume ────────────────────────────────────────────────────────────────────
function applyVolume(vol) {
    currentVolume = Math.max(0, Math.min(100, vol));
    localStorage.setItem('ytplayer_volume', currentVolume);
    audioEl.volume = currentVolume / 100;
    if (ytPlayerReady && ytPlayer) {
        try { ytPlayer.setVolume(currentVolume); } catch (_) {}
    }
    const bar = document.getElementById('volume-bar');
    if (bar) { bar.value = currentVolume; bar.style.setProperty('--fill', `${currentVolume}%`); }
    const icon = document.getElementById('vol-icon');
    if (icon) icon.textContent = currentVolume === 0 ? '🔇' : currentVolume < 50 ? '🔉' : '🔊';
}

// ── Sleep timer ───────────────────────────────────────────────────────────────
function setSleepTimer(minutes) {
    clearInterval(sleepTimerInterval);
    sleepTimerInterval = null;
    sleepTimerEnd = null;
    sleepTimerMins = minutes;
    const btn = document.getElementById('btn-sleep');
    const rem = document.getElementById('sleep-remaining');
    if (!minutes) {
        if (btn) { btn.classList.remove('active'); btn.title = 'Timer d\'arrêt automatique'; }
        if (rem) rem.textContent = '';
        return;
    }
    sleepTimerEnd = Date.now() + minutes * 60 * 1000;
    if (btn) { btn.classList.add('active'); btn.title = `Arrêt dans ${minutes} min`; }
    function tick() {
        const remaining = sleepTimerEnd - Date.now();
        if (remaining <= 0) {
            clearInterval(sleepTimerInterval); sleepTimerInterval = null;
            sleepTimerEnd = null; sleepTimerMins = 0;
            if (btn) { btn.classList.remove('active'); btn.title = 'Timer d\'arrêt automatique'; }
            if (rem) rem.textContent = '';
            wasPlayingOnHide = false;
            sendCmd('pauseVideo'); stopKeepAlive(); pauseTimer(); stopProgressLoop();
            isPlaying = false; setPlayBtn(false);
            showToast('🌙 Timer — lecture arrêtée');
            return;
        }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        if (rem) rem.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }
    tick();
    sleepTimerInterval = setInterval(tick, 1000);
    showToast(`🌙 Arrêt dans ${minutes} min`);
}

// ── Context menu piste ────────────────────────────────────────────────────────
function showTrackContextMenu(idx, x, y) {
    document.getElementById('track-ctx-menu')?.remove();
    const pl    = activePL();
    const track = pl?.tracks[idx];
    if (!track) return;

    const moveTargets = [];
    for (const [profId, prof] of Object.entries(state.profiles)) {
        for (const [plId, playlist] of Object.entries(prof.playlists)) {
            if (plId !== activeProfile()?.activePlaylistId)
                moveTargets.push({ profId, plId, label: profId === state.activeProfileId ? playlist.name : `${prof.name} › ${playlist.name}` });
        }
    }

    const menu = document.createElement('div');
    menu.id = 'track-ctx-menu';
    menu.className = 'ctx-menu';
    menu.innerHTML = `
        <div class="ctx-item" data-action="rename">&#9998; Renommer</div>
        <div class="ctx-item" data-action="copy-url">&#128279; Copier le lien</div>
        ${moveTargets.slice(0, 5).map(t => `<div class="ctx-item" data-action="move" data-plid="${t.plId}" data-profid="${t.profId}">&#10132; ${esc(t.label)}</div>`).join('')}
        <div class="ctx-sep"></div>
        <div class="ctx-item ctx-item-danger" data-action="delete">&#xD7; Supprimer</div>`;
    menu.style.cssText = `left:${x}px;top:${y}px`;
    document.body.appendChild(menu);

    requestAnimationFrame(() => {
        const r = menu.getBoundingClientRect();
        if (r.right  > window.innerWidth)  menu.style.left = `${Math.max(4, window.innerWidth  - r.width  - 4)}px`;
        if (r.bottom > window.innerHeight) menu.style.top  = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
    });

    menu.addEventListener('click', e => {
        const item = e.target.closest('.ctx-item');
        if (!item) return;
        const action = item.dataset.action;
        if (action === 'rename') {
            const n = prompt('Nouveau titre :', track.title);
            if (n?.trim()) { track.title = n.trim(); save(); renderTracks(); }
        } else if (action === 'copy-url') {
            navigator.clipboard?.writeText(`https://www.youtube.com/watch?v=${track.videoId}`)
                .then(() => showToast('✓ Lien copié !'));
        } else if (action === 'move') {
            const tProf = state.profiles[item.dataset.profid];
            const tPl   = tProf?.playlists[item.dataset.plid];
            if (!tPl) return;
            tPl.tracks.push({ ...track, id: uid() });
            delTrack(idx);
            save();
            showToast(`✓ Déplacé vers "${tPl.name}"`);
        } else if (action === 'delete') {
            delTrack(idx);
        }
        menu.remove();
    });

    setTimeout(() => {
        document.addEventListener('click', () => document.getElementById('track-ctx-menu')?.remove(), { once: true });
    }, 0);
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function getPlaybackPosition() {
    if (useNativeAudio) {
        return {
            current: isFinite(audioEl.currentTime) ? audioEl.currentTime : 0,
            total:   isFinite(audioEl.duration)    ? audioEl.duration    : (currentDurMs / 1000),
        };
    }
    if (ytPlayerReady && ytPlayer) {
        try {
            return {
                current: ytPlayer.getCurrentTime?.() || 0,
                total:   ytPlayer.getDuration?.()    || (currentDurMs / 1000) || 0,
            };
        } catch (_) {}
    }
    const elMs = elapsedMs + (timerStartedAt ? Date.now() - timerStartedAt : 0);
    return { current: elMs / 1000, total: currentDurMs / 1000 };
}

function updateProgressBar() {
    const bar   = document.getElementById('progress-bar');
    const elEl  = document.getElementById('time-elapsed');
    const totEl = document.getElementById('time-total');
    if (!bar) return;
    const { current, total } = getPlaybackPosition();
    const pct = total > 0 ? Math.min(current / total, 1) : 0;
    bar.value = Math.round(pct * 1000);
    bar.style.setProperty('--fill', `${pct * 100}%`);
    if (elEl)  elEl.textContent  = formatDuration(Math.floor(current));
    if (totEl) totEl.textContent = total > 0 ? formatDuration(Math.floor(total)) : '–';
}

function startProgressLoop() {
    if (progressInterval) return;
    progressInterval = setInterval(updateProgressBar, 250);
    updateProgressBar();
}

function stopProgressLoop() {
    clearInterval(progressInterval);
    progressInterval = null;
    updateProgressBar();
}

function seekTo(sec) {
    if (useNativeAudio) {
        audioEl.currentTime = sec;
    } else if (ytPlayerReady && ytPlayer) {
        try { ytPlayer.seekTo(sec, true); } catch (_) {}
    }
    elapsedMs = sec * 1000;
    if (timerStartedAt) {
        clearTimeout(autoNextTimer);
        timerStartedAt = Date.now();
        if (currentDurMs) {
            const remaining = currentDurMs - elapsedMs + 3000;
            if (remaining > 2000)
                autoNextTimer = setTimeout(() => { autoNextTimer = null; playNext(); }, remaining);
        }
    }
    updateProgressBar();
}

// ── Repeat mode ───────────────────────────────────────────────────────────────
function toggleRepeat() {
    repeatMode = (repeatMode + 1) % 3;
    const btn = document.getElementById('btn-repeat');
    if (!btn) return;
    btn.classList.toggle('active', repeatMode > 0);
    btn.dataset.mode = repeatMode;
    btn.title    = ['Répétition désactivée', 'Tout répéter', 'Répéter la piste'][repeatMode];
    btn.innerHTML = repeatMode === 2
        ? '&#8634;<span style="font-size:8px;vertical-align:super;font-weight:700">1</span>'
        : '&#8635;';
}

// ── Bottom-sheet swipe to dismiss ─────────────────────────────────────────────
function initBottomSheetSwipe(boxEl, hideFunc) {
    let startY = 0, isDragging = false;
    boxEl.addEventListener('touchstart', e => {
        startY = e.touches[0].clientY;
        isDragging = false;
        boxEl.style.transition = 'transform 0s';
    }, { passive: true });
    boxEl.addEventListener('touchmove', e => {
        const dy = e.touches[0].clientY - startY;
        const scrollEl = boxEl.querySelector('.search-results');
        if (dy > 8 && (!scrollEl || scrollEl.scrollTop <= 0)) {
            isDragging = true;
            boxEl.style.transform = `translateY(${Math.min(dy, 220)}px)`;
        }
    }, { passive: true });
    boxEl.addEventListener('touchend', e => {
        boxEl.style.transition = '';
        const dy = e.changedTouches[0].clientY - startY;
        if (dy > 80 && isDragging) {
            boxEl.style.transform = '';
            hideFunc();
        } else {
            boxEl.style.transform = '';
        }
        isDragging = false;
    }, { passive: true });
}

// ── Import playlist YouTube ───────────────────────────────────────────────────
async function importPlaylist(listId) {
    if (!ytApiKey) { showToast('Clé API YouTube requise.'); return; }
    const pl = activePL(); if (!pl) return;
    showToast('Importation…');
    let pageToken = '', count = 0;
    const existing = new Set(pl.tracks.map(t => t.videoId));
    try {
        do {
            const r = await fetch(
                `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${listId}${pageToken ? '&pageToken=' + pageToken : ''}&key=${ytApiKey}`,
                { signal: AbortSignal.timeout(10000) }
            );
            if (!r.ok) throw new Error();
            const data = await r.json();
            for (const item of data.items || []) {
                const vid   = item.snippet?.resourceId?.videoId;
                const title = item.snippet?.title;
                if (!vid || !title || title === 'Private video' || title === 'Deleted video') continue;
                if (existing.has(vid)) continue;
                existing.add(vid);
                pl.tracks.push({ id: uid(), videoId: vid, title, duration: 0 });
                count++;
            }
            pageToken = data.nextPageToken || '';
        } while (pageToken);
        if (state.isShuffled) resetShuffle(pl.tracks.length);
        save(); renderTracks();
        showToast(`✓ ${count} piste${count > 1 ? 's' : ''} importée${count > 1 ? 's' : ''} !`);
    } catch (_) { showToast('Erreur lors de l\'importation.'); }
}

// ── Worker-based audio streaming (arrière-plan natif) ────────────────────────
let workerUrl      = null;
let useNativeAudio = false;

async function fetchAudioStream(videoId) {
    if (!workerUrl) return null;
    try {
        const r = await fetch(
            `${workerUrl.replace(/\/$/, '')}/?v=${videoId}`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (!r.ok) return null;
        const { url } = await r.json();
        return url || null;
    } catch (_) { return null; }
}

const audioEl = new Audio();
audioEl.preload = 'none';
audioEl.volume  = currentVolume / 100;

audioEl.addEventListener('ended',  () => { clearTimeout(autoNextTimer); stopProgressLoop(); playNext(); });
audioEl.addEventListener('error',  () => {
    clearTimeout(autoNextTimer);
    stopProgressLoop();
    consecutiveFailures++;
    const plLen = activePL()?.tracks.length || 3;
    if (consecutiveFailures >= plLen) {
        consecutiveFailures = 0;
        showToast('Aucune piste disponible.');
        isPlaying = false; setPlayBtn(false);
        return;
    }
    setTimeout(playNext, 500);
});
audioEl.addEventListener('playing', () => {
    consecutiveFailures = 0;
    const dur = audioEl.duration;
    if (dur && isFinite(dur)) currentDurMs = dur * 1000;
    if (!timerStartedAt) resumeTimer();
    isPlaying = true; setPlayBtn(true);
    startProgressLoop();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audioEl.addEventListener('pause', () => {
    if (document.hidden && wasPlayingOnHide) { audioEl.play().catch(() => {}); return; }
    stopProgressLoop();
    pauseTimer();
    isPlaying = false; setPlayBtn(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});

// ── YouTube IFrame Player (fallback quand Worker indisponible) ────────────────
let ytPlayer     = null;
let ytPlayerReady = false;
let pendingVideoId = null;

window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('yt-player', {
        height: '200',
        width:  '100%',
        playerVars: {
            autoplay:       1,
            controls:       0,
            disablekb:      1,
            modestbranding: 1,
            rel:            0,
            origin:         location.origin,
        },
        events: {
            onReady:       onYTReady,
            onStateChange: onYTStateChange,
            onError:       onYTError,
        },
    });
};

function onYTReady() {
    ytPlayerReady = true;
    try { ytPlayer.setVolume(currentVolume); } catch (_) {}
    if (pendingVideoId) { ytPlayer.loadVideoById(pendingVideoId); pendingVideoId = null; }
}

function onYTStateChange(e) {
    if (e.data === YT.PlayerState.ENDED) {
        clearTimeout(autoNextTimer);
        stopKeepAlive();
        stopProgressLoop();
        playNext();
    } else if (e.data === YT.PlayerState.PLAYING) {
        consecutiveFailures = 0;
        const dur = ytPlayer.getDuration?.();
        if (dur && isFinite(dur)) currentDurMs = dur * 1000;
        if (!timerStartedAt) resumeTimer();
        isPlaying = true; setPlayBtn(true);
        startProgressLoop();
        startKeepAlive();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    } else if (e.data === YT.PlayerState.PAUSED) {
        if (document.hidden && wasPlayingOnHide) {
            setTimeout(() => { if (wasPlayingOnHide) ytPlayer?.playVideo(); }, 50);
            return;
        }
        stopKeepAlive();
        stopProgressLoop();
        pauseTimer();
        isPlaying = false; setPlayBtn(false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }
}

function onYTError() {
    clearTimeout(autoNextTimer);
    consecutiveFailures++;
    const plLen = activePL()?.tracks.length || 3;
    if (consecutiveFailures >= plLen) {
        consecutiveFailures = 0;
        showToast('Aucune piste disponible.');
        isPlaying = false; setPlayBtn(false);
        return;
    }
    setTimeout(playNext, 500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlightMatch(title, query) {
    if (!query) return esc(title);
    const i = title.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return esc(title);
    return esc(title.slice(0, i))
        + '<mark>' + esc(title.slice(i, i + query.length)) + '</mark>'
        + esc(title.slice(i + query.length));
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
    const data = JSON.parse(JSON.stringify({ version: 2, lastModified: Date.now(), profiles: state.profiles }));
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    pendingCloudSave = true;
    setSyncStatus('synced'); // optimiste : local est déjà à jour
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => cloudSave(data), 300);
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
    // Web Share Target
    if (window._pendingShareUrl) {
        const vid = extractVideoId(window._pendingShareUrl);
        if (vid) { addTrack(window._pendingShareUrl, ''); showToast('✓ Piste ajoutée via partage !'); }
        window._pendingShareUrl = null;
    }
    // Bookmarklet ?add=VIDEO_ID
    if (window._pendingAddVid) {
        addTrack(`https://www.youtube.com/watch?v=${window._pendingAddVid}`, '');
        showToast('✓ Piste ajoutée !');
        window._pendingAddVid = null;
    }
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
    trackFilter = '';
    const fi = document.getElementById('track-filter');
    if (fi) { fi.value = ''; }
    const fc = document.getElementById('track-filter-clear');
    if (fc) fc.style.display = 'none';
    save(); render();
}

// ── Track actions ─────────────────────────────────────────────────────────────
// ── Durée vidéo ───────────────────────────────────────────────────────────────
function parseIsoDuration(iso) {
    if (!iso) return 0;
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    return m ? (parseInt(m[1]||0)*3600 + parseInt(m[2]||0)*60 + parseInt(m[3]||0)) : 0;
}

async function fetchVideoDuration(videoId) {
    if (!ytApiKey) return 0;
    try {
        const r = await fetch(
            `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${ytApiKey}`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (!r.ok) return 0;
        return parseIsoDuration((await r.json()).items?.[0]?.contentDetails?.duration);
    } catch (_) { return 0; }
}

function addTrack(rawUrl, customTitle) {
    const pl = activePL(); if (!pl) return;
    const vid = extractVideoId(rawUrl.trim());
    if (!vid) { alert('Lien YouTube non reconnu.\nEx: https://www.youtube.com/watch?v=…'); return; }
    const idx = pl.tracks.length;
    pl.tracks.push({ id: uid(), videoId: vid, title: customTitle.trim() || 'Chargement…', duration: 0 });
    if (state.isShuffled) resetShuffle(pl.tracks.length);
    save(); renderTracks();
    const profId = state.activeProfileId;
    const plId   = activeProfile()?.activePlaylistId;
    fetchTitleAndDuration(vid, profId, plId, idx, !customTitle.trim());
}

async function fetchTitleAndDuration(vid, profId, plId, idx, fetchTitle) {
    const getTrack = () => state.profiles[profId]?.playlists[plId]?.tracks[idx];

    if (fetchTitle) {
        try {
            const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`);
            const d = r.ok ? await r.json() : null;
            const t = getTrack();
            if (t) { t.title = d?.title || `Piste ${idx + 1}`; save(); renderTracks(); }
        } catch (_) {
            const t = getTrack();
            if (t?.title === 'Chargement…') { t.title = `Piste ${idx + 1}`; save(); renderTracks(); }
        }
    }

    const duration = await fetchVideoDuration(vid);
    const t = getTrack();
    if (t) { t.duration = duration; save(); }
}

function delTrack(idx) {
    const pl = activePL(); if (!pl) return;
    const track = pl.tracks[idx];
    if (track) {
        // Tombstone : empêche la sync de restaurer cette piste
        if (!pl.deletedVideoIds) pl.deletedVideoIds = [];
        if (!pl.deletedVideoIds.includes(track.videoId)) pl.deletedVideoIds.push(track.videoId);
    }
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
    const track = pl.tracks[realIdx];
    loadVideo(track.videoId, track.duration || 0);
    // Durée inconnue : la récupérer et démarrer le timer dès qu'on l'a
    if (!track.duration) {
        const profId = state.activeProfileId;
        const plId   = activeProfile()?.activePlaylistId;
        fetchVideoDuration(track.videoId).then(dur => {
            if (!dur || state.trackIndex !== realIdx) return;
            const t = state.profiles[profId]?.playlists[plId]?.tracks[realIdx];
            if (t) { t.duration = dur; save(); }
            if (isPlaying && !timerStartedAt) { currentDurMs = dur * 1000; resumeTimer(); }
        });
    }
    updateMediaSession(track, track.videoId);
    shouldScrollToActive = true;
    renderNowPlaying(); renderTracks();
}

function playNext() {
    const pl = activePL(); if (!pl?.tracks.length) return;

    if (repeatMode === 2) { playAt(state.trackIndex); return; }

    if (state.isShuffled && state.shuffleOrder.length) {
        const n = (state.shufflePos + 1) % state.shuffleOrder.length;
        if (n === 0 && repeatMode === 0) { stopProgressLoop(); stopKeepAlive(); isPlaying = false; setPlayBtn(false); return; }
        state.shufflePos = n; playAt(state.shuffleOrder[n]);
    } else {
        const next = (state.trackIndex + 1) % pl.tracks.length;
        if (next === 0 && repeatMode === 0) { stopProgressLoop(); stopKeepAlive(); pauseTimer(); isPlaying = false; setPlayBtn(false); return; }
        playAt(next);
    }
}

function playPrev() {
    const pl = activePL(); if (!pl?.tracks.length) return;
    if (state.isShuffled && state.shuffleOrder.length) {
        const n = (state.shufflePos - 1 + state.shuffleOrder.length) % state.shuffleOrder.length;
        state.shufflePos = n; playAt(state.shuffleOrder[n]);
    } else { playAt(state.trackIndex <= 0 ? pl.tracks.length - 1 : state.trackIndex - 1); }
}

function togglePlayPause() {
    if (state.trackIndex < 0) { playAt(0); return; }
    if (isPlaying) {
        wasPlayingOnHide = false; // pause volontaire
        clearInterval(bgCheckInterval); bgCheckInterval = null;
        sendCmd('pauseVideo'); stopKeepAlive(); pauseTimer();
        isPlaying = false; setPlayBtn(false);
    } else {
        sendCmd('playVideo'); startKeepAlive(); resumeTimer();
        isPlaying = true; setPlayBtn(true);
    }
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
    el.dataset.playing = isPlaying ? '1' : '0';

    const query = trackFilter.trim().toLowerCase();
    const visible = pl.tracks
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => !query || t.title.toLowerCase().includes(query));

    if (!visible.length) {
        el.innerHTML = `<p class="empty">Aucune piste pour « ${esc(trackFilter.trim())} »</p>`;
        return;
    }

    el.innerHTML = visible.map(({ t, i }) => `
        <div class="track-item ${i === state.trackIndex ? 'active' : ''}" data-idx="${i}" draggable="${!query}">
            <span class="t-drag" title="Glisser pour réordonner">&#8942;&#8942;</span>
            <span class="t-num">${i + 1}</span>
            <span class="t-eq"><span></span><span></span><span></span></span>
            <span class="t-name" title="${esc(t.title)}">${highlightMatch(t.title, trackFilter.trim())}</span>
            ${t.duration ? `<span class="t-dur">${formatDuration(t.duration)}</span>` : ''}
            <button class="btn-del-t" data-idx="${i}">&#xD7;</button>
        </div>`).join('');

    el.querySelectorAll('.track-item').forEach(item => {
        item.addEventListener('click', e => {
            if (!e.target.classList.contains('btn-del-t') && !e.target.classList.contains('t-drag'))
                playAt(+item.dataset.idx);
        });
    });
    el.querySelectorAll('.btn-del-t').forEach(btn => btn.addEventListener('click', () => delTrack(+btn.dataset.idx)));

    // Drag & drop to reorder
    let dragSrcIdx = null;
    el.querySelectorAll('.track-item').forEach(item => {
        item.addEventListener('dragstart', e => {
            dragSrcIdx = +item.dataset.idx;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => item.classList.add('dragging'), 0);
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            el.querySelectorAll('.drag-over').forEach(d => d.classList.remove('drag-over'));
        });
        item.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            el.querySelectorAll('.drag-over').forEach(d => d.classList.remove('drag-over'));
            item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', e => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const dropIdx = +item.dataset.idx;
            if (dragSrcIdx === null || dragSrcIdx === dropIdx) return;
            const pl2 = activePL(); if (!pl2) return;
            const [moved] = pl2.tracks.splice(dragSrcIdx, 1);
            pl2.tracks.splice(dropIdx, 0, moved);
            if      (state.trackIndex === dragSrcIdx)                                     state.trackIndex = dropIdx;
            else if (dragSrcIdx < state.trackIndex && dropIdx >= state.trackIndex)        state.trackIndex--;
            else if (dragSrcIdx > state.trackIndex && dropIdx <= state.trackIndex)        state.trackIndex++;
            dragSrcIdx = null;
            if (state.isShuffled) resetShuffle(pl2.tracks.length);
            save(); renderTracks();
        });
    });

    // Context menu: right-click + long press
    el.querySelectorAll('.track-item').forEach(item => {
        let lpTimer = null;
        item.addEventListener('contextmenu', e => {
            e.preventDefault();
            showTrackContextMenu(+item.dataset.idx, e.clientX, e.clientY);
        });
        item.addEventListener('touchstart', e => {
            const t = e.touches[0];
            lpTimer = setTimeout(() => showTrackContextMenu(+item.dataset.idx, t.clientX, t.clientY), 500);
        }, { passive: true });
        item.addEventListener('touchmove',  () => clearTimeout(lpTimer));
        item.addEventListener('touchend',   () => clearTimeout(lpTimer));
    });

    const active = el.querySelector('.active');
    if (active && shouldScrollToActive) {
        active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        shouldScrollToActive = false;
    }
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

function showToast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = 'toast toast-show';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.className = 'toast', 2500);
}

function setPlayBtn(playing) {
    document.getElementById('btn-play-pause').innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
    const tl = document.getElementById('track-list');
    if (tl) tl.dataset.playing = playing ? '1' : '0';
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

// ── YouTube Search (API officielle Google) ────────────────────────────────────
let searchDebounce = null;

function formatDuration(s) {
    if (!s) return '–';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
}

function configureYtApiKey() {
    const current = ytApiKey ? `\nClé actuelle : ${ytApiKey.slice(0, 8)}…` : '';
    const key = prompt(
        `Clé API YouTube (gratuite — 100 recherches/jour)${current}\n\n` +
        `Comment obtenir votre clé gratuite :\n` +
        `1. Allez sur console.cloud.google.com\n` +
        `2. Créez un projet (ou choisissez-en un)\n` +
        `3. APIs et services → Bibliothèque → "YouTube Data API v3" → Activer\n` +
        `4. Identifiants → Créer des identifiants → Clé API\n\n` +
        `Collez votre clé ici :`
    );
    if (key?.trim()) {
        ytApiKey = key.trim();
        localStorage.setItem(YT_API_KEY_STORE, ytApiKey);
        showToast('✓ Clé API YouTube configurée !');
    }
}

async function searchYT(query) {
    const el = document.getElementById('search-results');
    el.innerHTML = '<p class="empty search-loading">Recherche en cours…</p>';

    if (!ytApiKey) {
        el.innerHTML = `
            <div class="empty" style="text-align:center;padding:24px 16px">
                <div style="font-size:28px;margin-bottom:12px">🔑</div>
                <p style="margin-bottom:12px">La recherche nécessite une clé API YouTube gratuite.<br>Les anciens serveurs tiers sont hors ligne.</p>
                <button class="btn-primary" id="btn-configure-yt-api" style="width:auto;padding:0 20px">Configurer la clé API (gratuit)</button>
            </div>`;
        document.getElementById('btn-configure-yt-api').addEventListener('click', () => {
            configureYtApiKey();
            if (ytApiKey) searchYT(query);
        });
        return;
    }

    try {
        const r = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&q=${encodeURIComponent(query)}&key=${ytApiKey}`,
            { signal: AbortSignal.timeout(8000) }
        );
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            if (r.status === 400 || r.status === 403) {
                el.innerHTML = `
                    <div class="empty" style="text-align:center;padding:16px">
                        <p style="margin-bottom:10px">Clé API invalide ou quota dépassé (${r.status}).</p>
                        <button class="btn-primary" id="btn-reconfig-yt-api" style="width:auto;padding:0 16px">Reconfigurer la clé</button>
                    </div>`;
                document.getElementById('btn-reconfig-yt-api').addEventListener('click', () => {
                    configureYtApiKey();
                    if (ytApiKey) searchYT(query);
                });
                return;
            }
            throw new Error();
        }
        const data = await r.json();
        const results = (data.items || []).map(i => ({
            videoId: i.id.videoId,
            title:   i.snippet.title,
            author:  i.snippet.channelTitle,
            lengthSeconds: 0,
        }));
        // Récupère les durées en batch
        const ids = results.map(r => r.videoId).join(',');
        if (ids && ytApiKey) {
            try {
                const dr = await fetch(
                    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${ytApiKey}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (dr.ok) {
                    const dd = await dr.json();
                    const map = {};
                    (dd.items || []).forEach(i => { map[i.id] = parseIsoDuration(i.contentDetails?.duration); });
                    results.forEach(r => { r.lengthSeconds = map[r.videoId] || 0; });
                }
            } catch (_) {}
        }
        renderSearchResults(results);
    } catch (_) {
        el.innerHTML = '<p class="empty">Erreur réseau. Vérifiez votre connexion.</p>';
    }
}

function renderSearchResults(results) {
    const el = document.getElementById('search-results');
    if (!results?.length) { el.innerHTML = '<p class="empty">Aucun résultat.</p>'; return; }
    el.innerHTML = results.slice(0, 15).map(v => `
        <div class="search-result" data-vid="${v.videoId}" data-title="${esc(v.title)}" data-dur="${v.lengthSeconds || 0}">
            <div class="result-thumb-wrap">
                <img class="result-thumb" src="https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg" loading="lazy" alt="">
                <div class="result-play-overlay">&#9654;</div>
            </div>
            <div class="result-info">
                <div class="result-title">${esc(v.title)}</div>
                <div class="result-meta">${esc(v.author)} · ${formatDuration(v.lengthSeconds)}</div>
            </div>
            <button class="btn-add-result" data-vid="${v.videoId}" data-title="${esc(v.title)}" data-dur="${v.lengthSeconds || 0}" title="Ajouter à la playlist sans lancer">+</button>
        </div>`).join('');

    // Clic sur la ligne → ajouter + lancer immédiatement
    el.querySelectorAll('.search-result').forEach(row => {
        row.addEventListener('click', e => {
            if (e.target.closest('.btn-add-result')) return;
            const pl = activePL(); if (!pl) return;
            const { vid, title, dur } = row.dataset;
            const duration = parseInt(dur || '0');
            let idx = pl.tracks.findIndex(t => t.videoId === vid);
            if (idx < 0) {
                idx = pl.tracks.length;
                pl.tracks.push({ id: uid(), videoId: vid, title, duration });
                if (state.isShuffled) resetShuffle(pl.tracks.length);
                save();
            }
            playAt(idx);
            hideSearchModal();
        });
    });

    // Bouton + → ajouter sans lancer
    el.querySelectorAll('.btn-add-result').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const pl = activePL(); if (!pl) return;
            if (pl.tracks.some(t => t.videoId === btn.dataset.vid)) {
                btn.textContent = '✓'; btn.classList.add('added');
                setTimeout(() => { btn.textContent = '+'; btn.classList.remove('added'); }, 1500);
                return;
            }
            pl.tracks.push({ id: uid(), videoId: btn.dataset.vid, title: btn.dataset.title, duration: parseInt(btn.dataset.dur || '0') });
            if (state.isShuffled) resetShuffle(pl.tracks.length);
            save(); renderTracks();
            btn.textContent = '✓'; btn.classList.add('added');
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

// ── Media Session API (contrôles écran verrouillé) ───────────────────────────
function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => {
        wasPlayingOnHide = true;
        sendCmd('playVideo'); startKeepAlive(); resumeTimer(); isPlaying = true; setPlayBtn(true);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    });
    navigator.mediaSession.setActionHandler('pause', () => {
        wasPlayingOnHide = false; // pause volontaire — ne pas reprendre automatiquement
        clearInterval(bgCheckInterval); bgCheckInterval = null;
        sendCmd('pauseVideo'); stopKeepAlive(); pauseTimer(); isPlaying = false; setPlayBtn(false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    });
    navigator.mediaSession.setActionHandler('nexttrack',     playNext);
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
}

function updateMediaSession(track, videoId) {
    if (!('mediaSession' in navigator)) return;
    const pl = activePL();
    navigator.mediaSession.metadata = new MediaMetadata({
        title:  track.title,
        artist: activeProfile()?.name || 'YT Player',
        album:  pl?.name || '',
        artwork: [
            { src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' },
            { src: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, sizes: '320x180', type: 'image/jpeg' },
        ],
    });
    navigator.mediaSession.playbackState = 'playing';
}

// ── Lecteur (Worker → audio natif | sinon YouTube IFrame) ────────────────────
let loadVideoSeq        = 0;
let consecutiveFailures = 0;

async function loadVideo(videoId, durationSec) {
    const seq = ++loadVideoSeq;
    clearTimeout(autoNextTimer);
    autoNextTimer  = null;
    elapsedMs      = 0;
    timerStartedAt = null;
    currentDurMs   = (durationSec || 0) * 1000;
    stopProgressLoop();
    updateProgressBar();

    document.getElementById('player-placeholder').style.display = 'none';
    isPlaying = true; setPlayBtn(true);

    // ── Essayer le Worker d'abord (audio natif = arrière-plan) ──
    if (workerUrl) {
        const url = await fetchAudioStream(videoId);
        if (seq !== loadVideoSeq) return;
        if (url) {
            useNativeAudio = true;
            stopKeepAlive();
            clearInterval(bgCheckInterval); bgCheckInterval = null;
            const coverEl = document.getElementById('cover-art');
            if (coverEl) { coverEl.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`; coverEl.style.display = 'block'; }
            const ytBox = document.getElementById('yt-player');
            if (ytBox) ytBox.style.display = 'none';
            audioEl.src = url;
            audioEl.play().catch(() => {});
            return;
        }
    }

    // ── Fallback : YouTube IFrame ──
    useNativeAudio = false;
    const coverEl = document.getElementById('cover-art');
    if (coverEl) coverEl.style.display = 'none';
    const ytBox = document.getElementById('yt-player');
    if (ytBox) ytBox.style.display = '';
    if (!ytPlayerReady) { pendingVideoId = videoId; return; }
    ytPlayer.loadVideoById(videoId);
}

function sendCmd(func) {
    if (useNativeAudio) {
        if (func === 'playVideo')  audioEl.play().catch(() => {});
        if (func === 'pauseVideo') audioEl.pause();
    } else {
        if (!ytPlayerReady) return;
        if (func === 'playVideo')  ytPlayer.playVideo();
        if (func === 'pauseVideo') ytPlayer.pauseVideo();
    }
}

function pauseTimer() {
    if (!timerStartedAt) return;
    elapsedMs += Date.now() - timerStartedAt;
    timerStartedAt = null;
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
}

function resumeTimer() {
    if (!currentDurMs || timerStartedAt) return;
    const remaining = currentDurMs - elapsedMs + 3000; // +3 s buffer
    if (remaining <= 2000) { playNext(); return; }
    timerStartedAt = Date.now();
    autoNextTimer = setTimeout(() => { autoNextTimer = null; playNext(); }, remaining);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {

    // ── Web Share Target & bookmarklet : capturer les params entrants ──
    const _sp = new URLSearchParams(location.search);
    const _sharedUrl = _sp.get('share_url') || _sp.get('share_text');
    const _addVid    = _sp.get('add');
    if (_sharedUrl || _addVid) {
        history.replaceState(null, '', location.pathname + (location.hash || ''));
        if (_sharedUrl) window._pendingShareUrl = _sharedUrl;
        if (_addVid)    window._pendingAddVid   = _addVid;
    }

    // Token : URL #sync=TOKEN > localStorage > défaut injecté par CI
    if (location.hash.startsWith('#sync=')) {
        ghToken = decodeURIComponent(location.hash.slice(6));
        localStorage.setItem(TOKEN_KEY, ghToken);
        history.replaceState(null, '', location.pathname);
        showToast('✓ Synchronisation configurée !');
    } else {
        ghToken = localStorage.getItem(TOKEN_KEY);
        if (!ghToken && DEFAULT_TOKEN !== '__SYNC_TOKEN__') {
            ghToken = DEFAULT_TOKEN;
            localStorage.setItem(TOKEN_KEY, ghToken);
        }
    }

    ytApiKey  = localStorage.getItem(YT_API_KEY_STORE) || DEFAULT_YT_KEY;
    if (!localStorage.getItem(YT_API_KEY_STORE)) localStorage.setItem(YT_API_KEY_STORE, ytApiKey);
    workerUrl = localStorage.getItem(WORKER_KEY) || DEFAULT_WORKER;
    setSyncStatus(ghToken ? 'syncing' : 'offline');

    // 1. Charger depuis le cloud
    let data      = await cloudLoad();
    const local   = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    const hasCloud = data?.profiles && Object.keys(data.profiles).length > 0;
    const hasLocal = local?.profiles && Object.keys(local.profiles).length > 0;

    if (!hasCloud && hasLocal) {
        // Cloud vide : utiliser local et pousser au cloud
        data = local;
        if (ghToken) cloudSave(data);
    } else if (hasCloud && hasLocal) {
        const localTs = local.lastModified || 0;
        const cloudTs = data.lastModified  || 0;
        if (localTs >= cloudTs) {
            // Local aussi récent ou plus récent que cloud (CDN potentiellement périmé)
            // Local gagne TOUJOURS sur ex-æquo pour éviter l'écrasement par CDN périmé
            data = local;
            if (ghToken && localTs > cloudTs) cloudSave(data); // push si local strictement plus récent
        } else {
            // Cloud strictement plus récent → un autre appareil a fait des changements
            localStorage.setItem(CACHE_KEY, JSON.stringify(data));
        }
    } else if (data) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } else {
        data = local;
    }

    setSyncStatus(ghToken ? (data ? 'synced' : 'error') : 'offline');

    // 2. Migrate v1 → v2 si nécessaire
    if (data && data.version !== 2) {
        data = migrateV1(data) || { version: 2, profiles: {} };
        if (ghToken) cloudSave(data);
    }

    state.profiles = data?.profiles || {};

    // 3. Restaurer le profil de cet appareil
    const savedId = localStorage.getItem(PROFILE_KEY);
    if (savedId && state.profiles[savedId]) {
        selectProfile(savedId);
    } else {
        showProfileScreen();
    }

    // 4. Sync multi-appareils + reprise arrière-plan
    document.addEventListener('visibilitychange', async () => {
        if (document.hidden) {
            isInBackground   = true;
            wasPlayingOnHide = isPlaying;
            // Vérification périodique toutes les 2 s si IFrame joue en arrière-plan
            if (isPlaying && !useNativeAudio && ytPlayerReady) {
                bgCheckInterval = setInterval(() => {
                    if (wasPlayingOnHide && ytPlayerReady) {
                        try {
                            const s = ytPlayer.getPlayerState?.();
                            if (s === YT.PlayerState.PAUSED) ytPlayer.playVideo();
                        } catch (_) {}
                    }
                }, 2000);
            }
            return;
        }
        isInBackground = false;
        clearInterval(bgCheckInterval);
        bgCheckInterval = null;
        // Reprendre si YouTube a mis en pause en arrière-plan
        if (wasPlayingOnHide && ytPlayerReady) {
            try { ytPlayer.playVideo(); } catch (_) {}
        }
        wasPlayingOnHide = false;
        // Sync multi-appareils : remplace par le cloud s'il est plus récent (pas de merge)
        if (pendingCloudSave) return;
        const fresh = await cloudLoad();
        if (!fresh?.profiles) return;
        const localTs = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}').lastModified || 0;
        if ((fresh.lastModified || 0) <= localTs) { setSyncStatus('synced'); return; }
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

    // Bouton ⚙ : ouvre la modale de sync
    function openSyncModal() {
        const tokenInput   = document.getElementById('sync-token-input');
        const shareSection = document.getElementById('sync-share-section');
        const urlInput     = document.getElementById('sync-setup-url');
        tokenInput.value   = ghToken || '';
        if (ghToken) {
            urlInput.value = `${location.origin}${location.pathname}#sync=${encodeURIComponent(ghToken)}`;
            shareSection.style.display = 'block';
        } else {
            shareSection.style.display = 'none';
        }
        const workerInput = document.getElementById('worker-url-input');
        if (workerInput) workerInput.value = workerUrl || '';
        document.getElementById('sync-setup-modal').style.display = 'flex';
    }
    document.getElementById('btn-sync-setup').addEventListener('click', openSyncModal);

    document.getElementById('btn-save-worker-url')?.addEventListener('click', () => {
        const val = document.getElementById('worker-url-input').value.trim();
        if (val) {
            workerUrl = val.replace(/\/$/, '');
            localStorage.setItem(WORKER_KEY, workerUrl);
            showToast('✓ Worker URL enregistrée — arrière-plan activé !');
        } else {
            workerUrl = null;
            localStorage.removeItem(WORKER_KEY);
            showToast('Worker URL supprimée.');
        }
    });

    document.getElementById('btn-save-token').addEventListener('click', () => {
        const key = document.getElementById('sync-token-input').value.trim();
        if (!key) {
            // Champ vide = réinitialiser vers le token injecté par CI
            localStorage.removeItem(TOKEN_KEY);
            ghToken = DEFAULT_TOKEN !== '__SYNC_TOKEN__' ? DEFAULT_TOKEN : null;
            if (ghToken) localStorage.setItem(TOKEN_KEY, ghToken);
            setSyncStatus(ghToken ? 'syncing' : 'offline');
            if (ghToken) cloudSave({ version: 2, profiles: state.profiles });
            document.getElementById('sync-share-section').style.display = 'none';
            showToast(ghToken ? '✓ Token réinitialisé !' : 'Token effacé.');
            return;
        }
        ghToken = key;
        localStorage.setItem(TOKEN_KEY, ghToken);
        setSyncStatus('syncing');
        cloudSave({ version: 2, profiles: state.profiles });
        const urlInput = document.getElementById('sync-setup-url');
        urlInput.value = `${location.origin}${location.pathname}#sync=${encodeURIComponent(ghToken)}`;
        document.getElementById('sync-share-section').style.display = 'block';
        showToast('✓ Token enregistré — sync activée !');
    });

    document.getElementById('btn-copy-sync-url').addEventListener('click', () => {
        const input = document.getElementById('sync-setup-url');
        input.select(); navigator.clipboard?.writeText(input.value);
        showToast('✓ Lien copié ! Mets-le en favori sur chaque appareil.');
    });

    // ── Bookmarklet : générer et copier ──
    const _bBase = `${location.origin}${location.pathname}`;
    const _bCode = `javascript:(function(){var m=location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})|youtu\\.be\\/([a-zA-Z0-9_-]{11})|shorts\\/([a-zA-Z0-9_-]{11})/),id=m&&(m[1]||m[2]||m[3]);id?location.href='${_bBase}?add='+id:alert('Pas de vid\\u00e9o YouTube.');})();`;
    const _bInput = document.getElementById('bookmarklet-input');
    if (_bInput) _bInput.value = _bCode;
    document.getElementById('btn-copy-bookmarklet')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(_bCode).then(() => showToast('✓ Bookmarklet copié !'));
    });
    document.getElementById('btn-close-sync-modal').addEventListener('click', () => {
        document.getElementById('sync-setup-modal').style.display = 'none';
    });

    // ── Media session (contrôles verrouillage) ──
    setupMediaSession();

    // ── Installation PWA ──
    document.getElementById('btn-install')?.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        document.getElementById('install-banner').style.display = 'none';
    });
    document.getElementById('btn-install-close')?.addEventListener('click', () => {
        document.getElementById('install-banner').style.display = 'none';
    });

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

    // ── Filtre de pistes ──
    function applyTrackFilter() {
        const fi = document.getElementById('track-filter');
        trackFilter = fi ? fi.value : '';
        document.getElementById('track-filter-clear').style.display = trackFilter ? 'block' : 'none';
        renderTracks();
    }
    const trackFilterEl = document.getElementById('track-filter');
    trackFilterEl.addEventListener('input', applyTrackFilter);
    trackFilterEl.addEventListener('keyup', applyTrackFilter);
    trackFilterEl.addEventListener('compositionend', applyTrackFilter);
    document.getElementById('track-filter-clear').addEventListener('click', () => {
        trackFilter = '';
        trackFilterEl.value = '';
        document.getElementById('track-filter-clear').style.display = 'none';
        renderTracks();
        trackFilterEl.focus();
    });

    document.getElementById('btn-new-playlist').addEventListener('click', () => {
        const name = prompt('Nom de la nouvelle playlist :');
        if (name?.trim()) newPlaylist(name.trim());
    });

    document.getElementById('btn-add').addEventListener('click', () => {
        const url   = document.getElementById('url-input').value.trim();
        const title = document.getElementById('title-input').value;
        if (!url) { document.getElementById('url-input').focus(); return; }
        // Playlist URL (list= sans v=) → import batch
        const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        if (listMatch && !extractVideoId(url)) {
            importPlaylist(listMatch[1]);
            document.getElementById('url-input').value = '';
            return;
        }
        addTrack(url, title);
        document.getElementById('url-input').value  = '';
        document.getElementById('title-input').value = '';
        document.getElementById('url-input').focus();
    });

    document.getElementById('url-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('btn-add').click();
    });

    // Auto-convert any YouTube URL to youtube-nocookie embed format on paste
    document.getElementById('url-input').addEventListener('paste', () => {
        setTimeout(() => {
            const input = document.getElementById('url-input');
            const vid = extractVideoId(input.value.trim());
            if (vid) input.value = `https://www.youtube-nocookie.com/embed/${vid}`;
        }, 0);
    });

    document.getElementById('btn-play-pause').addEventListener('click', togglePlayPause);
    document.getElementById('btn-next').addEventListener('click', playNext);
    document.getElementById('btn-prev').addEventListener('click', playPrev);
    document.getElementById('btn-shuffle').addEventListener('click', toggleShuffle);
    document.getElementById('btn-repeat').addEventListener('click', toggleRepeat);
    document.getElementById('btn-clear').addEventListener('click', clearTracks);

    // ── Progress bar seek ──
    const progressBar = document.getElementById('progress-bar');
    progressBar.addEventListener('input', e => {
        const pct = e.target.value / 1000;
        e.target.style.setProperty('--fill', `${pct * 100}%`);
        const { total } = getPlaybackPosition();
        const elEl = document.getElementById('time-elapsed');
        if (elEl && total > 0) elEl.textContent = formatDuration(Math.floor(pct * total));
    });
    progressBar.addEventListener('change', e => {
        const pct = e.target.value / 1000;
        const { total } = getPlaybackPosition();
        if (total > 0) seekTo(pct * total);
    });

    // ── Swipe bas pour fermer la modale de recherche ──
    initBottomSheetSwipe(document.querySelector('#search-modal .search-modal-box'), hideSearchModal);

    // ── Volume ──
    applyVolume(currentVolume);
    const volumeBar = document.getElementById('volume-bar');
    volumeBar.addEventListener('input', e => applyVolume(+e.target.value));
    document.getElementById('vol-icon').addEventListener('click', () => {
        if (currentVolume > 0) { prevVolume = currentVolume; applyVolume(0); }
        else                    applyVolume(prevVolume || 80);
    });

    // ── Sleep timer ──
    document.getElementById('btn-sleep').addEventListener('click', () => {
        const idx  = SLEEP_PRESETS.indexOf(sleepTimerMins);
        const next = SLEEP_PRESETS[(idx + 1) % SLEEP_PRESETS.length];
        setSleepTimer(next);
    });

    document.addEventListener('keydown', e => {
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (e.code === 'Space')      { e.preventDefault(); togglePlayPause(); }
        if (e.code === 'ArrowRight') playNext();
        if (e.code === 'ArrowLeft')  playPrev();
    });
});
