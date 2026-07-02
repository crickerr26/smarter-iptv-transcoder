const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join('/tmp', 'smarter-iptv-hls');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

fs.mkdirSync(MEDIA_ROOT, { recursive: true });

const sessions = new Map();
const mime = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': 'content-type,range,authorization',
    'access-control-expose-headers': 'content-length,content-range,accept-ranges',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'content-type': 'application/json' });
}

function authorized(u) {
  if (!ACCESS_TOKEN) return true;
  const token = u.searchParams.get('token') || '';
  const a = Buffer.from(token);
  const b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionId(url, profile) {
  return crypto.createHash('sha1').update(`${profile}\n${url}`).digest('hex').slice(0, 24);
}

function safePath(id, file = '') {
  const dir = path.resolve(MEDIA_ROOT, id);
  const target = path.resolve(dir, file);
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('Bad path');
  return { dir, target };
}

function profileArgs(profile) {
  if (profile === 'audio') return ['-vn', '-c:a', 'aac', '-b:a', '96k'];
  if (profile === 'copy') return ['-c', 'copy'];
  const videoBitrate = profile === 'vod' ? '1200k' : '750k';
  const maxrate = profile === 'vod' ? '1500k' : '900k';
  const bufsize = profile === 'vod' ? '3000k' : '1800k';
  return [
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'superfast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level', '3.1',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=w=min(854\\,iw):h=-2',
    '-g', '50',
    '-keyint_min', '50',
    '-sc_threshold', '0',
    '-b:v', videoBitrate,
    '-maxrate', maxrate,
    '-bufsize', bufsize,
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2'
  ];
}

function inputArgs(profile, url) {
  const liveTuning = profile === 'live' ? [
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '2500000',
    '-probesize', '5000000'
  ] : ['-fflags', '+genpts+discardcorrupt'];
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-err_detect', 'ignore_err',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '4',
    '-rw_timeout', '15000000',
    ...liveTuning,
    '-i', url
  ];
}

function hlsArgs(profile, dir, playlist) {
  const live = profile === 'live';
  return [
    '-f', 'hls',
    '-hls_time', live ? '4' : '6',
    '-hls_list_size', live ? '15' : '0',
    '-hls_flags', live
      ? 'delete_segments+append_list+omit_endlist+independent_segments+temp_file'
      : 'independent_segments+temp_file',
    '-hls_allow_cache', live ? '0' : '1',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    playlist
  ];
}

function start(url, profile = 'mobile') {
  const id = sessionId(url, profile);
  const existing = sessions.get(id);
  if (existing && !existing.exited) {
    existing.lastAccess = Date.now();
    return existing;
  }

  const { dir } = safePath(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const playlist = path.join(dir, 'index.m3u8');
  const args = [
    ...inputArgs(profile, url),
    ...profileArgs(profile),
    '-avoid_negative_ts', 'make_zero',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-max_muxing_queue_size', '4096',
    ...hlsArgs(profile, dir, playlist)
  ];

  const session = { id, url, profile, child: null, playlist, dir, created: Date.now(), lastAccess: Date.now(), exited: false, log: '' };
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  session.child = child;
  child.on('error', error => {
    session.exited = true;
    session.exitCode = -1;
    session.log = (`FFmpeg failed to start: ${error.message}\n` + session.log).slice(-4000);
  });
  child.stderr.on('data', chunk => {
    session.log = (session.log + chunk.toString()).slice(-4000);
  });
  child.on('exit', code => {
    session.exited = true;
    session.exitCode = code;
  });
  sessions.set(id, session);
  return session;
}

async function waitForPlaylist(session, ms = 30000) {
  const file = session.playlist;
  const startAt = Date.now();
  while (Date.now() - startAt < ms) {
    if (session.exited && !fs.existsSync(file)) return false;
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const segments = (content.match(/#EXTINF:/g) || []).length;
        if (segments >= 2 || content.includes('#EXT-X-ENDLIST')) return true;
      } catch (e) {}
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function waitForFile(file, ms = 8000) {
  const startAt = Date.now();
  while (Date.now() - startAt < ms) {
    if (fs.existsSync(file)) {
      try {
        const stat = fs.statSync(file);
        if (stat.size > 0) return true;
      } catch (e) {}
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess < SESSION_TTL_MS) continue;
    if (session.child && !session.exited) session.child.kill('SIGTERM');
    fs.rmSync(session.dir, { recursive: true, force: true });
    sessions.delete(id);
  }
}
setInterval(cleanup, 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method not allowed');
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (u.pathname === '/health') {
      return json(res, 200, { ok: true, sessions: sessions.size });
    }

    if (u.pathname === '/hls') {
      if (!authorized(u)) return json(res, 401, { error: 'Unauthorized' });
      const source = u.searchParams.get('url');
      const profile = u.searchParams.get('profile') || 'mobile';
      if (!source || !/^https?:\/\//i.test(source)) return json(res, 400, { error: 'Missing url' });
      const session = start(source, profile);
      const ok = await waitForPlaylist(session);
      if (!ok) return json(res, 504, { error: 'Transcoder did not produce HLS yet', log: session.log });
      const location = `${PUBLIC_BASE_URL || ''}/sessions/${session.id}/index.m3u8`;
      res.writeHead(302, {
        location,
        'access-control-allow-origin': CORS_ORIGIN,
        'cache-control': 'no-store'
      });
      return res.end();
    }

    if (u.pathname.startsWith('/sessions/')) {
      const parts = u.pathname.split('/').filter(Boolean);
      const id = parts[1];
      const file = parts.slice(2).join('/');
      const session = sessions.get(id);
      if (!session) return json(res, 404, { error: 'Session expired' });
      session.lastAccess = Date.now();
      const { target } = safePath(id, file);
      const ext = path.extname(target);
      const ready = await waitForFile(target, ext === '.m3u8' ? 5000 : 10000);
      if (!ready) return json(res, 404, { error: 'Not ready' });
      const stat = fs.statSync(target);
      const baseHeaders = {
        'access-control-allow-origin': CORS_ORIGIN,
        'access-control-expose-headers': 'content-length,content-range,accept-ranges',
        'cache-control': ext === '.m3u8' ? 'no-store' : 'public, max-age=120',
        'content-type': mime[ext] || 'application/octet-stream',
        'accept-ranges': 'bytes'
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...baseHeaders, 'content-length': stat.size });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          let start = match[1] ? Number(match[1]) : 0;
          let end = match[2] ? Number(match[2]) : stat.size - 1;
          if (!match[1] && match[2]) start = Math.max(0, stat.size - end);
          end = Math.min(end, stat.size - 1);
          if (start <= end && start < stat.size) {
            res.writeHead(206, {
              ...baseHeaders,
              'content-range': `bytes ${start}-${end}/${stat.size}`,
              'content-length': end - start + 1
            });
            return fs.createReadStream(target, { start, end }).pipe(res);
          }
        }
        res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(200, {
        ...baseHeaders,
        'content-length': stat.size
      });
      return fs.createReadStream(target).pipe(res);
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    json(res, 500, { error: error.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Smarter IPTV transcoder listening on ${PORT}`);
});
