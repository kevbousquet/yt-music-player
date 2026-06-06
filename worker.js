// YT Audio Worker — Cloudflare Worker
// Extracts YouTube audio stream URLs for native <audio> playback.
// Deploy at https://dash.cloudflare.com → Workers & Pages → Create Worker.

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type':                 'application/json',
};

// InnerTube clients tried in order. iOS + Android return direct URLs (no cipher).
const CLIENTS = [
  {
    id: '5', name: 'IOS', version: '19.45.4',
    ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
  },
  {
    id: '3', name: 'ANDROID', version: '19.10.39',
    ua: 'com.google.android.youtube/19.10.39 (Linux; U; Android 14) gzip',
    extra: { androidSdkVersion: 34 },
  },
  {
    id: '56', name: 'ANDROID_EMBEDDED_PLAYER', version: '19.10.39',
    ua: 'com.google.android.youtube/19.10.39 (Linux; U; Android 14) gzip',
    extra: { androidSdkVersion: 34 },
    third: { embedUrl: 'https://www.youtube.com/' },
  },
];

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    const v = new URL(req.url).searchParams.get('v');
    if (!v || !/^[a-zA-Z0-9_-]{11}$/.test(v))
      return res({ error: 'bad_id' }, 400);

    for (const c of CLIENTS) {
      try {
        const url = await tryClient(v, c);
        if (url) return res({ url });
      } catch (_) {}
    }
    return res({ error: 'not_found' }, 404);
  },
};

async function tryClient(videoId, c) {
  const r = await fetch(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      method: 'POST',
      headers: {
        'Content-Type':             'application/json',
        'User-Agent':               c.ua,
        'X-YouTube-Client-Name':    c.id,
        'X-YouTube-Client-Version': c.version,
        'Origin':                   'https://www.youtube.com',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: c.name, clientVersion: c.version,
            userAgent: c.ua, hl: 'en', gl: 'US',
            ...(c.extra || {}),
          },
          ...(c.third ? { thirdParty: c.third } : {}),
        },
        videoId,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
      }),
    }
  );
  if (!r.ok) return null;
  const d = await r.json();
  if (d.playabilityStatus?.status !== 'OK') return null;

  const audio = (d.streamingData?.adaptiveFormats || [])
    .filter(f => f.mimeType?.startsWith('audio') && f.url);
  if (!audio.length) return null;

  return (audio.find(f => f.mimeType?.includes('mp4'))
    || audio.sort((a, b) => b.bitrate - a.bitrate)[0]).url;
}

function res(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
