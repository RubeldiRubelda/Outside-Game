import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production';
const preferredPort = Number(process.env.PORT || 777);
const fallbackPort = Number(process.env.FALLBACK_PORT || 7777);
const adminToken = process.env.ADMIN_TOKEN || 'trail-777';

const TEAM_IDS = ['red', 'blue'];
const MAX_EVENTS = 50;
const CHEAT_RADIUS_METERS = 45;
const STALE_LOCATION_MS = 20_000;
const IMPOSSIBLE_SPEED_KMH = 90;

function createTeam(id, name, color) {
  return {
    id,
    name,
    color,
    members: {},
    lastPosition: null,
    lastUpload: null,
    flags: [],
    checkpoints: 0,
  };
}

function createState() {
  return {
    status: 'lobby',
    leadingTeamId: 'red',
    activeTeamId: 'red',
    headStartMinutes: 5,
    headStartEndsAt: null,
    startedAt: null,
    currentCheckpoint: null,
    pendingReview: null,
    events: [],
    settings: {
      captureRadiusMeters: CHEAT_RADIUS_METERS,
      staleLocationMs: STALE_LOCATION_MS,
      impossibleSpeedKmh: IMPOSSIBLE_SPEED_KMH,
    },
    teams: {
      red: createTeam('red', 'Team Rot', '#ff6b6b'),
      blue: createTeam('blue', 'Team Blau', '#4dabf7'),
    },
  };
}

const state = createState();
const codes = {}; // map gameCode -> { createdAt, teamId, members: { socketId: teamId }, teams: { red: [socketIds], blue: [socketIds] } }

function generateCode(length = 6) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function createTeamCode(teamId) {
  let next = generateCode();
  while (codes[next]) next = generateCode();
  codes[next] = { createdAt: nowIso(), teamId, members: {}, teams: { red: [], blue: [] } };
  return next;
}

function nowIso() {
  return new Date().toISOString();
}

function pushEvent(type, message, details = {}) {
  state.events.unshift({ id: crypto.randomUUID(), type, message, details, time: nowIso() });
  state.events = state.events.slice(0, MAX_EVENTS);
}

function otherTeamId(teamId) {
  return teamId === 'red' ? 'blue' : 'red';
}

function haversineMeters(a, b) {
  if (!a || !b) {
    return null;
  }

  const earthRadius = 6_371_000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180;
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const aValue = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(aValue)));
}

function bearingDegrees(from, to) {
  if (!from || !to) {
    return 0;
  }

  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const deltaLng = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function computePublicTeam(team) {
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    checkpoints: team.checkpoints,
    memberCount: Object.keys(team.members).length,
    lastPosition: team.lastPosition,
    lastUpload: team.lastUpload,
    flags: team.flags,
    locationAgeMs: team.lastPosition ? Date.now() - new Date(team.lastPosition.time).getTime() : null,
  };
}

function computePublicState() {
  return {
    status: state.status,
    leadingTeamId: state.leadingTeamId,
    activeTeamId: state.activeTeamId,
    headStartMinutes: state.headStartMinutes,
    headStartEndsAt: state.headStartEndsAt,
    startedAt: state.startedAt,
    currentCheckpoint: state.currentCheckpoint,
    pendingReview: state.pendingReview,
    events: state.events,
    settings: state.settings,
    teams: {
      red: computePublicTeam(state.teams.red),
      blue: computePublicTeam(state.teams.blue),
    },
  };
}

function computeAdminState() {
  return {
    ...computePublicState(),
    teams: {
      red: {
        ...computePublicTeam(state.teams.red),
        members: Object.values(state.teams.red.members),
      },
      blue: {
        ...computePublicTeam(state.teams.blue),
        members: Object.values(state.teams.blue.members),
      },
    },
  };
}

function flagTeam(teamId, message) {
  const team = state.teams[teamId];
  team.flags.unshift({ id: crypto.randomUUID(), message, time: nowIso() });
  team.flags = team.flags.slice(0, 10);
  pushEvent('warning', message, { teamId });
}

function updateTeamFlags(teamId) {
  const team = state.teams[teamId];
  if (!team.lastPosition) {
    return;
  }

  const ageMs = Date.now() - new Date(team.lastPosition.time).getTime();
  const staleFlag = ageMs > STALE_LOCATION_MS;
  const hasStaleFlag = team.flags.some((flag) => flag.message.includes('Standort-Update'));

  if (staleFlag && !hasStaleFlag) {
    flagTeam(teamId, 'Standort-Update ist zu alt. Team wirkt offline oder funkt nicht zuverlässig.');
  }
}

function broadcast(io) {
  io.emit('state:update', computePublicState());
  io.to('admins').emit('admin:update', computeAdminState());
}

function startGame(io, options = {}) {
  state.status = 'head_start';
  state.leadingTeamId = options.leadingTeamId || state.leadingTeamId;
  state.activeTeamId = state.leadingTeamId;
  state.headStartMinutes = Number(options.headStartMinutes || state.headStartMinutes || 5);
  state.startedAt = nowIso();
  state.headStartEndsAt = new Date(Date.now() + state.headStartMinutes * 60_000).toISOString();
  state.currentCheckpoint = null;
  state.pendingReview = null;
  state.teams.red.lastUpload = null;
  state.teams.blue.lastUpload = null;
  pushEvent('game-start', `Spiel gestartet. ${state.teams[state.leadingTeamId].name} hat den Vorsprung.`, {
    leadingTeamId: state.leadingTeamId,
    headStartMinutes: state.headStartMinutes,
  });
}

function resetGame() {
  const nextState = createState();
  state.status = nextState.status;
  state.leadingTeamId = nextState.leadingTeamId;
  state.activeTeamId = nextState.activeTeamId;
  state.headStartMinutes = nextState.headStartMinutes;
  state.headStartEndsAt = nextState.headStartEndsAt;
  state.startedAt = nextState.startedAt;
  state.currentCheckpoint = nextState.currentCheckpoint;
  state.pendingReview = nextState.pendingReview;
  state.events = nextState.events;
  state.settings = nextState.settings;
  state.teams.red = nextState.teams.red;
  state.teams.blue = nextState.teams.blue;
  pushEvent('game-reset', 'Spielstatus wurde zurückgesetzt.');
}

function canUpload(teamId) {
  if (state.status === 'review' || state.pendingReview) {
    return { ok: false, message: 'Ein Bild wird gerade geprüft. Erst nach Annahme oder Ablehnung geht es weiter.' };
  }

  if (state.status === 'lobby') {
    return { ok: false, message: 'Das Spiel wurde noch nicht gestartet.' };
  }

  if (state.status === 'head_start') {
    if (teamId !== state.leadingTeamId) {
      return { ok: false, message: 'In der Vorsprung-Phase darf nur das führende Team das erste Foto hochladen.' };
    }

    if (Date.now() < new Date(state.headStartEndsAt).getTime()) {
      return { ok: false, message: 'Der Vorsprung läuft noch. Erst nach 5 Minuten ist der erste Upload erlaubt.' };
    }
  }

  if (state.currentCheckpoint && teamId !== state.activeTeamId) {
    return { ok: false, message: 'Gerade ist das andere Team an der Reihe.' };
  }

  return { ok: true };
}

function resolveCheckpointCheck(teamId, location) {
  if (!state.currentCheckpoint || state.activeTeamId === teamId) {
    return { ok: true, distanceMeters: null };
  }

  if (!location) {
    return { ok: true, distanceMeters: null };
  }

  const distanceMeters = haversineMeters(state.currentCheckpoint.location, location);
  if (distanceMeters !== null && distanceMeters > state.settings.captureRadiusMeters) {
    return {
      ok: false,
      distanceMeters,
      message: `Der Upload ist ${Math.round(distanceMeters)} m vom Zielpunkt entfernt. Maximal ${state.settings.captureRadiusMeters} m erlaubt.`,
    };
  }

  return { ok: true, distanceMeters };
}

function sanitizeText(input, fallback) {
  const trimmed = String(input ?? '').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 80) : fallback;
}

function toCheckpoint(photo, team) {
  return {
    id: photo.id,
    teamId: photo.uploadTeamId,
    teamName: team.name,
    location: photo.location || team.lastPosition,
    uploadedAt: photo.createdAt,
    caption: photo.caption,
    preview: photo.dataUrl,
  };
}

async function main() {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: { origin: true, credentials: true },
    maxHttpBufferSize: 20_000_000,
  });
  let vite = null;

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      appType: 'custom',
      server: { middlewareMode: true },
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(rootDir, 'dist/client');
    app.use(express.static(distPath));
  }

  app.get('/healthz', (_, res) => {
    res.json({ ok: true, status: state.status });
  });

  // Admin password management: first visitor can set a password via POST /admin/password
  // and clients can check whether a password is already set via GET /admin/password
  let adminPassword = process.env.ADMIN_PASSWORD || null;

  app.get('/admin/password', (_, res) => {
    res.json({ set: !!adminPassword });
  });

  app.post('/admin/password', (req, res) => {
    if (adminPassword) {
      return res.status(403).json({ ok: false, message: 'Admin password is already set.' });
    }
    const pwd = req.body && req.body.password ? String(req.body.password).trim() : '';
    if (!pwd || pwd.length < 4) {
      return res.status(400).json({ ok: false, message: 'Password too short (min 4 chars).' });
    }
    adminPassword = pwd;
    pushEvent('admin', 'Admin password wurde gesetzt.');
    broadcast(io);
    return res.json({ ok: true });
  });

  app.get('/alert.mp3', (_, res) => {
    const alertPath = path.resolve(rootDir, 'alert.mp3');
    if (!fs.existsSync(alertPath)) {
      return res.status(404).end();
    }
    return res.sendFile(alertPath);
  });

  app.get('*', async (req, res) => {
    const indexPath = isProduction ? path.resolve(rootDir, 'dist/client/index.html') : path.resolve(rootDir, 'index.html');
    let template = fs.readFileSync(indexPath, 'utf8');

    if (!isProduction && vite) {
      template = await vite.transformIndexHtml(req.originalUrl, template);
    }

    res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
  });

  io.on('connection', (socket) => {
    socket.on('join', (payload = {}, callback = () => {}) => {
      const role = payload.role === 'admin' ? 'admin' : 'player';
      const requestedTeam = TEAM_IDS.includes(payload.teamId) ? payload.teamId : null;
      const displayName = sanitizeText(payload.name, role === 'admin' ? 'Admin' : 'Spieler');

      socket.data.role = role;
      socket.data.name = displayName;

      // code-based join
      const gameCode = typeof payload.code === 'string' && payload.code.trim() ? payload.code.trim().toUpperCase() : null;
      if (role === 'admin') {
        // require admin password to be set and provided
        if (!adminPassword) {
          callback({ ok: false, message: 'Admin password not set. Bitte setze es unter /admin.' });
          return;
        }
        const pw = payload && payload.password ? String(payload.password) : '';
        if (pw !== adminPassword) {
          callback({ ok: false, message: 'Ungültiges Admin-Passwort.' });
          return;
        }
        socket.join('admins');
        socket.data.isAdmin = true;
        callback({ ok: true, state: computeAdminState() });
        return;
      }

      if (gameCode) {
        const codeEntry = codes[gameCode];
        if (!codeEntry) {
          callback({ ok: false, message: 'Unbekannter Spielcode.' });
          return;
        }

        const teamId = codeEntry.teamId || requestedTeam || 'red';

        socket.data.teamId = teamId;
        // register in code map
        codeEntry.members[socket.id] = teamId;
        codeEntry.teams[teamId].push(socket.id);

        // register in global team state as before
        state.teams[teamId].members[socket.id] = {
          id: socket.id,
          name: displayName,
          joinedAt: nowIso(),
          lastSeenAt: nowIso(),
        };
        pushEvent('player-join', `${displayName} ist über Code ${gameCode} für ${state.teams[teamId].name} beigetreten.`, { teamId, gameCode });
        callback({ ok: true, state: computePublicState(), assignedTeam: teamId });
        broadcast(io);
        return;
      }

      // legacy join without code: behave as before (assign provided or default team)
      const teamId = requestedTeam || 'red';
      socket.data.teamId = teamId;
      state.teams[teamId].members[socket.id] = {
        id: socket.id,
        name: displayName,
        joinedAt: nowIso(),
        lastSeenAt: nowIso(),
      };
      pushEvent('player-join', `${displayName} ist für ${state.teams[teamId].name} beigetreten.`, { teamId });
      callback({ ok: true, state: computePublicState() });
      broadcast(io);
    });

    socket.on('admin:create-code', (payload = {}, callback = () => {}) => {
      if (!socket.data.isAdmin) {
        callback({ ok: false, message: 'Nicht autorisiert.' });
        return;
      }

      const teamId = TEAM_IDS.includes(payload.teamId) ? payload.teamId : null;
      if (!teamId) {
        callback({ ok: false, message: 'Bitte Team Rot oder Blau auswählen.' });
        return;
      }

      const next = createTeamCode(teamId);
      pushEvent('admin-code', `Neuer Spielcode ${next} für ${state.teams[teamId].name} erstellt.`, { code: next, teamId });
      callback({ ok: true, code: next, teamId, codes: Object.fromEntries(Object.entries(codes).map(([code, value]) => [code, value.teamId])) });
      broadcast(io);
    });

    socket.on('player:position', (payload = {}) => {
      const teamId = socket.data.teamId;
      if (!TEAM_IDS.includes(teamId)) {
        return;
      }

      const location = payload.location && Number.isFinite(payload.location.lat) && Number.isFinite(payload.location.lng)
        ? {
            lat: Number(payload.location.lat),
            lng: Number(payload.location.lng),
            accuracy: Number(payload.location.accuracy || 0),
            heading: Number(payload.location.heading || 0),
            speed: Number(payload.location.speed || 0),
            time: nowIso(),
          }
        : null;

      if (!location) {
        return;
      }

      const team = state.teams[teamId];
      const previous = team.lastPosition;
      team.lastPosition = location;
      const member = team.members[socket.id];
      if (member) {
        member.lastSeenAt = nowIso();
        member.location = location;
      }

      if (previous) {
        const distanceMeters = haversineMeters(previous, location);
        const elapsedHours = Math.max(0.0001, (new Date(location.time).getTime() - new Date(previous.time).getTime()) / 3_600_000);
        const speedKmh = distanceMeters ? distanceMeters / 1000 / elapsedHours : 0;
        if (speedKmh > state.settings.impossibleSpeedKmh) {
          flagTeam(teamId, `Unplausibler Standortsprung von ${Math.round(speedKmh)} km/h erkannt.`);
        }
      }

      updateTeamFlags(teamId);
      broadcast(io);
    });

    socket.on('player:photo', (payload = {}, callback = () => {}) => {
      const teamId = socket.data.teamId;
      if (!TEAM_IDS.includes(teamId)) {
        callback({ ok: false, message: 'Nur Teams dürfen Fotos hochladen.' });
        return;
      }

      const uploadCheck = canUpload(teamId);
      if (!uploadCheck.ok) {
        callback(uploadCheck);
        return;
      }

      const location = payload.location && Number.isFinite(payload.location.lat) && Number.isFinite(payload.location.lng)
        ? {
            lat: Number(payload.location.lat),
            lng: Number(payload.location.lng),
            accuracy: Number(payload.location.accuracy || 0),
            heading: Number(payload.location.heading || 0),
            speed: Number(payload.location.speed || 0),
            time: nowIso(),
          }
        : null;

      const positionCheck = resolveCheckpointCheck(teamId, location);
      if (!positionCheck.ok) {
        callback(positionCheck);
        return;
      }

      const team = state.teams[teamId];
      const photo = {
        id: crypto.randomUUID(),
        name: sanitizeText(payload.name, `${team.name} Foto`),
        caption: sanitizeText(payload.caption, ''),
        dataUrl: typeof payload.dataUrl === 'string' && payload.dataUrl.startsWith('data:image') ? payload.dataUrl : null,
        createdAt: nowIso(),
        location,
        uploadTeamId: teamId,
        checkpointDistanceMeters: positionCheck.distanceMeters,
      };

      team.lastUpload = photo;
      team.checkpoints += 1;
      state.status = 'live';
      if (state.status === 'head_start' && Date.now() >= new Date(state.headStartEndsAt).getTime()) {
        state.status = 'live';
      }

      const isResponseRound = state.currentCheckpoint && state.currentCheckpoint.teamId !== teamId;

      if (isResponseRound) {
        state.pendingReview = {
          id: photo.id,
          reviewTeamId: state.leadingTeamId,
          uploadTeamId: teamId,
          checkpoint: toCheckpoint(photo, team),
        };
        state.status = 'review';
        state.activeTeamId = state.leadingTeamId;
        pushEvent('photo-review-pending', `${team.name} hat ein Antwortbild gesendet. ${state.teams[state.leadingTeamId].name} muss jetzt annehmen oder ablehnen.`, {
          teamId,
          reviewTeamId: state.leadingTeamId,
          checkpointDistanceMeters: positionCheck.distanceMeters,
        });
      } else {
        state.currentCheckpoint = toCheckpoint(photo, team);
        state.activeTeamId = otherTeamId(teamId);
        pushEvent('photo-upload', `${team.name} hat ein Bild gepostet. Jetzt ist ${state.teams[state.activeTeamId].name} dran.`, {
          teamId,
          checkpointDistanceMeters: positionCheck.distanceMeters,
        });
      }

      callback({ ok: true, state: computePublicState() });
      broadcast(io);
    });

    socket.on('player:review', (payload = {}, callback = () => {}) => {
      const teamId = socket.data.teamId;
      if (!TEAM_IDS.includes(teamId)) {
        callback({ ok: false, message: 'Nur Teams dürfen prüfen.' });
        return;
      }

      if (!state.pendingReview) {
        callback({ ok: false, message: 'Es liegt gerade kein Bild zur Prüfung vor.' });
        return;
      }

      if (teamId !== state.leadingTeamId || state.pendingReview.reviewTeamId !== state.leadingTeamId) {
        callback({ ok: false, message: 'Nur das Startteam darf Bilder prüfen.' });
        return;
      }

      const action = payload.action === 'reject' ? 'reject' : 'accept';
      const review = state.pendingReview;
      const reviewerTeam = state.teams[teamId];
      const uploaderTeam = state.teams[review.uploadTeamId];

      if (action === 'accept') {
        state.currentCheckpoint = review.checkpoint;
        state.activeTeamId = teamId;
        state.pendingReview = null;
        state.status = 'live';
        pushEvent('photo-approved', `${reviewerTeam.name} hat das Bild von ${uploaderTeam.name} angenommen.`, {
          reviewTeamId: teamId,
          uploadTeamId: review.uploadTeamId,
        });
      } else {
        state.pendingReview = null;
        state.activeTeamId = review.uploadTeamId;
        state.status = 'live';
        pushEvent('photo-rejected', `${reviewerTeam.name} hat das Bild von ${uploaderTeam.name} abgelehnt.`, {
          reviewTeamId: teamId,
          uploadTeamId: review.uploadTeamId,
        });
      }

      callback({ ok: true, state: computePublicState() });
      broadcast(io);
    });

    socket.on('admin:start', (payload = {}, callback = () => {}) => {
      if (!socket.data.isAdmin) {
        callback({ ok: false, message: 'Nicht autorisiert.' });
        return;
      }

      startGame(io, payload);
      callback({ ok: true, state: computeAdminState() });
      broadcast(io);
    });

    socket.on('admin:reset', (payload = {}, callback = () => {}) => {
      if (!socket.data.isAdmin) {
        callback({ ok: false, message: 'Nicht autorisiert.' });
        return;
      }

      resetGame();
      callback({ ok: true, state: computeAdminState() });
      broadcast(io);
    });

    socket.on('admin:configure', (payload = {}, callback = () => {}) => {
      if (!socket.data.isAdmin) {
        callback({ ok: false, message: 'Nicht autorisiert.' });
        return;
      }

      if (TEAM_IDS.includes(payload.leadingTeamId)) {
        state.leadingTeamId = payload.leadingTeamId;
        state.activeTeamId = payload.leadingTeamId;
      }

      const minutes = Number(payload.headStartMinutes);
      if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 30) {
        state.headStartMinutes = Math.round(minutes);
      }

      state.teams.red.name = sanitizeText(payload.redName, state.teams.red.name);
      state.teams.blue.name = sanitizeText(payload.blueName, state.teams.blue.name);

      pushEvent('settings', 'Spielkonfiguration aktualisiert.', {
        leadingTeamId: state.leadingTeamId,
        headStartMinutes: state.headStartMinutes,
      });

      callback({ ok: true, state: computeAdminState() });
      broadcast(io);
    });

    socket.on('admin:tip', (payload = {}, callback = () => {}) => {
      if (!socket.data.isAdmin) {
        callback({ ok: false, message: 'Nicht autorisiert.' });
        return;
      }

      const message = sanitizeText(payload.message, '');
      if (!message) {
        callback({ ok: false, message: 'Bitte einen Tipptext eingeben.' });
        return;
      }

      const teamId = TEAM_IDS.includes(payload.teamId) ? payload.teamId : null;
      pushEvent('admin-tip', message, { teamId });
      callback({ ok: true, state: computeAdminState() });
      broadcast(io);
    });

    socket.on('admin:pin', (payload = {}, callback = () => {}) => {
      if (!socket.data.isAdmin) {
        callback({ ok: false, message: 'Nicht autorisiert.' });
        return;
      }

      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        callback({ ok: false, message: 'Bitte gültige Koordinaten für den Pin eingeben.' });
        return;
      }

      const teamId = TEAM_IDS.includes(payload.teamId) ? payload.teamId : null;
      const label = sanitizeText(payload.label, 'Standortpin');
      pushEvent('admin-pin', label, { teamId, location: { lat, lng } });
      callback({ ok: true, state: computeAdminState() });
      broadcast(io);
    });

    socket.on('disconnect', () => {
      const teamId = socket.data.teamId;
      if (TEAM_IDS.includes(teamId) && state.teams[teamId].members[socket.id]) {
        const memberName = state.teams[teamId].members[socket.id].name;
        delete state.teams[teamId].members[socket.id];
        pushEvent('player-leave', `${memberName} hat die Verbindung getrennt.`, { teamId });
        broadcast(io);
      }
    });
  });

  let hasFallenBack = false;

  const startListening = (listenPort) => {
    server.listen(listenPort, () => {
      console.log(`Outside Game is running on http://localhost:${listenPort}`);
    });
  };

  server.on('error', (error) => {
    if (!hasFallenBack && (error.code === 'EACCES' || error.code === 'EADDRINUSE') && preferredPort < 1024) {
      hasFallenBack = true;
      console.warn(`Port ${preferredPort} is not available in this environment. Falling back to ${fallbackPort} for local development.`);
      startListening(fallbackPort);
      return;
    }

    throw error;
  });

  startListening(preferredPort);
}

await main();