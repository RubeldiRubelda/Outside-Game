import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type TeamId = 'red' | 'blue';
type ViewMode = 'intro' | 'player' | 'admin';

type Position = {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number;
  speed: number;
  time: string;
};

type TeamSummary = {
  id: TeamId;
  name: string;
  color: string;
  checkpoints: number;
  memberCount: number;
  lastPosition: Position | null;
  lastUpload: PhotoRecord | null;
  flags: Array<{ id: string; message: string; time: string }>;
  locationAgeMs: number | null;
};

type PhotoRecord = {
  id: string;
  name: string;
  caption: string;
  dataUrl: string | null;
  createdAt: string;
  location: Position | null;
  uploadTeamId: TeamId;
  checkpointDistanceMeters: number | null;
};

type Snapshot = {
  status: 'lobby' | 'head_start' | 'live';
  leadingTeamId: TeamId;
  activeTeamId: TeamId;
  headStartMinutes: number;
  headStartEndsAt: string | null;
  startedAt: string | null;
  currentCheckpoint: null | {
    id: string;
    teamId: TeamId;
    teamName: string;
    location: Position | null;
    uploadedAt: string;
    caption: string;
    preview: string | null;
  };
  events: Array<{ id: string; type: string; message: string; details: Record<string, unknown>; time: string }>;
  settings: {
    captureRadiusMeters: number;
    staleLocationMs: number;
    impossibleSpeedKmh: number;
  };
  teams: Record<TeamId, TeamSummary>;
};

type JoinResult = { ok: boolean; message?: string; state?: Snapshot };
type UploadResult = JoinResult;

const TEAM_META: Record<TeamId, { name: string; accent: string; label: string }> = {
  red: { name: 'Team Rot', accent: '#ff6b6b', label: 'Rot' },
  blue: { name: 'Team Blau', accent: '#4dabf7', label: 'Blau' },
};

function formatTime(time?: string | null) {
  if (!time) {
    return 'n/a';
  }

  return new Date(time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(time?: string | null) {
  if (!time) {
    return 'n/a';
  }

  return new Date(time).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDistance(distance?: number | null) {
  if (distance === null || distance === undefined) {
    return '–';
  }

  if (distance < 1000) {
    return `${Math.round(distance)} m`;
  }

  return `${(distance / 1000).toFixed(2)} km`;
}

function formatRelative(ms?: number | null) {
  if (ms === null || ms === undefined) {
    return 'keine Werte';
  }

  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function distanceMeters(a: Position | null, b: Position | null) {
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

function bearingDegrees(from: Position, to: Position) {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const deltaLng = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function buildUrl(mode: ViewMode, teamId?: TeamId, adminToken?: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  if (teamId) {
    url.searchParams.set('team', teamId);
  }
  if (adminToken) {
    url.searchParams.set('adminToken', adminToken);
  }
  return url;
}

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const [mode, setMode] = useState<ViewMode>(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('mode') as ViewMode) || 'intro';
  });
  const [teamId, setTeamId] = useState<TeamId>('red');
  const [name, setName] = useState('');
  const [adminToken, setAdminToken] = useState(() => window.localStorage.getItem('outside-game-admin-token') || 'trail-777');
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState('');
  const [manualLat, setManualLat] = useState('48.137');
  const [manualLng, setManualLng] = useState('11.575');
  const [selectedPhoto, setSelectedPhoto] = useState<File | null>(null);
  const [photoCaption, setPhotoCaption] = useState('Standort bestätigt');
  const [isBusy, setIsBusy] = useState(false);
  const [location, setLocation] = useState<Position | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tracker' | 'upload' | 'status'>('tracker');
  const [adminInputRed, setAdminInputRed] = useState('Team Rot');
  const [adminInputBlue, setAdminInputBlue] = useState('Team Blau');
  const [adminHeadStart, setAdminHeadStart] = useState('5');
  const [adminLeader, setAdminLeader] = useState<TeamId>('red');

  const isPlayer = mode === 'player';
  const isAdmin = mode === 'admin';

  const currentState = snapshot;
  const activeTeam = currentState ? currentState.teams[teamId] : null;
  const targetCheckpoint = currentState?.currentCheckpoint?.location || null;

  const viewStateText = useMemo(() => {
    if (!currentState) {
      return 'Warten auf Spielstatus…';
    }

    if (currentState.status === 'lobby') {
      return 'Spiel noch nicht gestartet';
    }

    if (currentState.status === 'head_start') {
      return `Vorsprung läuft für ${TEAM_META[currentState.leadingTeamId].name}`;
    }

    return `Jagd läuft. Dran ist ${TEAM_META[currentState.activeTeamId].name}`;
  }, [currentState]);

  useEffect(() => {
    if (!photoPreview) {
      return undefined;
    }

    return () => URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  useEffect(() => {
    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      const params = new URLSearchParams(window.location.search);
      const storedName = window.localStorage.getItem('outside-game-name');
      const playerName = params.get('name') || storedName || 'Spieler';
      const resolvedTeam = (params.get('team') as TeamId) || teamId;
      const resolvedMode = (params.get('mode') as ViewMode) || mode;
      const joinRole = resolvedMode === 'admin' ? 'admin' : 'player';

      socket.emit('join', {
        role: joinRole,
        teamId: resolvedTeam,
        name: joinRole === 'admin' ? 'Admin' : playerName,
      }, (response: JoinResult) => {
        if (response.ok && response.state) {
          setSnapshot(response.state);
        }

        if (!response.ok && response.message) {
          setMessage(response.message);
        }
      });
    });

    socket.on('disconnect', () => setConnected(false));
    socket.on('state:update', (nextState: Snapshot) => setSnapshot(nextState));
    socket.on('admin:update', (nextState: Snapshot) => setSnapshot(nextState));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [mode, teamId]);

  useEffect(() => {
    if (!isPlayer || !socketRef.current || !connected) {
      return undefined;
    }

    if (!navigator.geolocation) {
      setMessage('Geolocation wird von diesem Browser nicht unterstützt. Nutze die manuelle Position.');
      return undefined;
    }

    const sendPosition = (coords: GeolocationCoordinates) => {
      const nextPosition: Position = {
        lat: coords.latitude,
        lng: coords.longitude,
        accuracy: coords.accuracy,
        heading: coords.heading ?? 0,
        speed: coords.speed ?? 0,
        time: new Date().toISOString(),
      };

      setLocation(nextPosition);
      socketRef.current?.emit('player:position', { location: nextPosition });
    };

    const watcher = navigator.geolocation.watchPosition(
      (result) => sendPosition(result.coords),
      () => setMessage('Standortzugriff fehlt oder wurde verweigert. Nutze die manuelle Position unten.'),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 12_000 },
    );

    return () => {
      navigator.geolocation.clearWatch(watcher);
    };
  }, [isPlayer, connected]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      if (navigator.geolocation && isPlayer && connected && socketRef.current) {
        navigator.geolocation.getCurrentPosition(
          (result) => {
            const nextPosition: Position = {
              lat: result.coords.latitude,
              lng: result.coords.longitude,
              accuracy: result.coords.accuracy,
              heading: result.coords.heading ?? 0,
              speed: result.coords.speed ?? 0,
              time: new Date().toISOString(),
            };
            setLocation(nextPosition);
            socketRef.current?.emit('player:position', { location: nextPosition });
          },
          () => undefined,
          { enableHighAccuracy: true, timeout: 10_000 },
        );
      }
    }, 6_000);

    return () => window.clearInterval(tick);
  }, [connected, isPlayer]);

  const joinAsPlayer = (nextTeamId: TeamId) => {
    setTeamId(nextTeamId);
    setMode('player');
    window.localStorage.setItem('outside-game-name', name || 'Spieler');
    const nextUrl = buildUrl('player', nextTeamId);
    window.history.replaceState({}, '', nextUrl.toString());
  };

  const joinAsAdmin = () => {
    setMode('admin');
    window.localStorage.setItem('outside-game-admin-token', adminToken);
    const nextUrl = buildUrl('admin', undefined, adminToken);
    window.history.replaceState({}, '', nextUrl.toString());
  };

  const sendManualPosition = () => {
    const lat = Number(manualLat);
    const lng = Number(manualLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setMessage('Bitte gültige Koordinaten eingeben.');
      return;
    }

    const nextPosition: Position = { lat, lng, accuracy: 15, heading: 0, speed: 0, time: new Date().toISOString() };
    setLocation(nextPosition);
    socketRef.current?.emit('player:position', { location: nextPosition });
    setMessage(`Manuelle Position gesendet: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  };

  const submitPhoto = async () => {
    if (!socketRef.current || !selectedPhoto) {
      setMessage('Bitte zuerst ein Foto auswählen.');
      return;
    }

    setIsBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Foto konnte nicht gelesen werden.'));
        reader.readAsDataURL(selectedPhoto);
      });

      socketRef.current.emit(
        'player:photo',
        {
          name: selectedPhoto.name,
          caption: photoCaption,
          dataUrl,
          location,
        },
        (response: UploadResult) => {
          if (response.ok) {
            setMessage('Foto erfolgreich hochgeladen.');
            setSelectedPhoto(null);
            setPhotoPreview(null);
            if (response.state) {
              setSnapshot(response.state);
            }
          } else {
            setMessage(response.message || 'Upload fehlgeschlagen.');
          }
          setIsBusy(false);
        },
      );
    } catch (error) {
      setIsBusy(false);
      setMessage(error instanceof Error ? error.message : 'Upload fehlgeschlagen.');
    }
  };

  const startGame = () => {
    socketRef.current?.emit(
      'admin:start',
      {
        token: adminToken,
        leadingTeamId: adminLeader,
        headStartMinutes: Number(adminHeadStart),
      },
      (response: JoinResult) => {
        if (response.ok && response.state) {
          setSnapshot(response.state);
          setMessage('Spiel gestartet.');
        } else {
          setMessage(response.message || 'Start fehlgeschlagen.');
        }
      },
    );
  };

  const resetGame = () => {
    socketRef.current?.emit('admin:reset', { token: adminToken }, (response: JoinResult) => {
      if (response.ok && response.state) {
        setSnapshot(response.state);
        setMessage('Spiel zurückgesetzt.');
      } else {
        setMessage(response.message || 'Reset fehlgeschlagen.');
      }
    });
  };

  const applyAdminConfig = () => {
    socketRef.current?.emit(
      'admin:configure',
      {
        token: adminToken,
        redName: adminInputRed,
        blueName: adminInputBlue,
        leadingTeamId: adminLeader,
        headStartMinutes: Number(adminHeadStart),
      },
      (response: JoinResult) => {
        if (response.ok && response.state) {
          setSnapshot(response.state);
          setMessage('Konfiguration gespeichert.');
        } else {
          setMessage(response.message || 'Konfiguration fehlgeschlagen.');
        }
      },
    );
  };

  const activeCheckpointDistance = useMemo(() => {
    if (!location || !targetCheckpoint) {
      return null;
    }

    return distanceMeters(location, targetCheckpoint);
  }, [location, targetCheckpoint]);

  const markerPositions = useMemo(() => {
    if (!currentState?.currentCheckpoint?.location) {
      return [] as Array<{ id: TeamId | 'checkpoint'; x: number; y: number; label: string; color: string }>;
    }

    const center = currentState.currentCheckpoint.location;
    return (['red', 'blue'] as TeamId[])
      .map((id) => {
        const position = currentState.teams[id].lastPosition;
        if (!position) {
          return null;
        }

        const distance = Math.min(250, (distanceMeters(center, position) || 0) / 12);
        const angle = (bearingDegrees(center, position) * Math.PI) / 180;
        return {
          id,
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
          label: currentState.teams[id].name,
          color: currentState.teams[id].color,
        };
      })
      .filter(Boolean) as Array<{ id: TeamId | 'checkpoint'; x: number; y: number; label: string; color: string }>;
  }, [currentState]);

  const checkpointLabel = currentState?.currentCheckpoint
    ? `${currentState.currentCheckpoint.teamName} · ${formatDateTime(currentState.currentCheckpoint.uploadedAt)}`
    : 'Noch kein Startfoto hochgeladen';

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Realtime Gelände-Game</p>
          <h1>Outside Game</h1>
          <p className="lede">
            Zwei Teams, ein wandernder Zielpunkt, Live-GPS für Admins und Foto-Uploads als Beweis. Alles läuft in
            Echtzeit über einen einzigen Docker-Container auf Port 777.
          </p>
          <div className="hero-pill-row">
            <span className="pill">{connected ? 'Verbunden' : 'Verbindung wird aufgebaut'}</span>
            <span className="pill">{viewStateText}</span>
            <span className="pill">Port 777</span>
          </div>
        </div>
        <div className="hero-panel">
          <div className="status-card status-card-wide">
            <div>
              <p className="card-label">Aktueller Modus</p>
              <strong>{mode === 'intro' ? 'Startbildschirm' : mode === 'player' ? 'Spieleransicht' : 'Admin'}</strong>
            </div>
            <div>
              <p className="card-label">Spielstatus</p>
              <strong>{currentState?.status ?? 'offline'}</strong>
            </div>
          </div>
          <div className="quick-grid">
            <button className="mode-card" onClick={() => setMode('player')}>
              <span>Spieler</span>
              <small>GPS, Upload, Teamwahl</small>
            </button>
            <button className="mode-card" onClick={() => setMode('admin')}>
              <span>Admin</span>
              <small>Live-Tracking, Cheat-Warnungen</small>
            </button>
          </div>
        </div>
      </section>

      {message ? <div className="banner">{message}</div> : null}

      {mode === 'intro' ? (
        <section className="setup-grid">
          <article className="panel">
            <h2>Spieler beitreten</h2>
            <p>Team wählen, Namen setzen und Standortfreigabe erlauben. Alternativ manuell Koordinaten senden.</p>
            <div className="form-grid">
              <label>
                Name
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="z. B. Lara" />
              </label>
              <label>
                Team
                <select value={teamId} onChange={(event) => setTeamId(event.target.value as TeamId)}>
                  <option value="red">Team Rot</option>
                  <option value="blue">Team Blau</option>
                </select>
              </label>
            </div>
            <div className="button-row">
              <button className="primary" onClick={() => joinAsPlayer(teamId)}>
                Als Spieler beitreten
              </button>
              <button className="secondary" onClick={() => setMode('admin')}>
                Admin öffnen
              </button>
            </div>
          </article>

          <article className="panel">
            <h2>Admin-Setup</h2>
            <p>Damit lassen sich Startteam und Vorsprung konfigurieren. Der Admin-Token wird lokal gespeichert.</p>
            <div className="form-grid">
              <label>
                Admin-Token
                <input value={adminToken} onChange={(event) => setAdminToken(event.target.value)} />
              </label>
              <label>
                Vorsprung in Minuten
                <input value={adminHeadStart} onChange={(event) => setAdminHeadStart(event.target.value)} inputMode="numeric" />
              </label>
            </div>
            <div className="button-row">
              <button className="primary" onClick={joinAsAdmin}>
                Admin-Dashboard öffnen
              </button>
              <button className="secondary" onClick={() => setMode('player')}>
                Zurück zum Spiel
              </button>
            </div>
          </article>
        </section>
      ) : null}

      {isPlayer ? (
        <section className="dashboard-grid">
          <article className="panel focus-panel">
            <div className="section-head">
              <div>
                <p className="card-label">Dein Team</p>
                <h2>{activeTeam?.name ?? TEAM_META[teamId].name}</h2>
              </div>
              <span className="status-chip" style={{ borderColor: TEAM_META[teamId].accent, color: TEAM_META[teamId].accent }}>
                {TEAM_META[teamId].label}
              </span>
            </div>
            <p>{currentState?.status === 'head_start' ? 'Der Vorsprung läuft noch. Erst danach ist der erste Upload erlaubt.' : 'Halte Kontakt zum Zielpunkt und lade den nächsten Beweis hoch.'}</p>

            <div className="status-card-grid">
              <div className="mini-card">
                <span className="card-label">Dein Standort</span>
                <strong>{location ? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}` : 'Noch kein GPS'}</strong>
              </div>
              <div className="mini-card">
                <span className="card-label">Zielpunkt entfernt</span>
                <strong>{formatDistance(activeCheckpointDistance)}</strong>
              </div>
              <div className="mini-card">
                <span className="card-label">Letzter Upload</span>
                <strong>{activeTeam?.lastUpload ? formatDateTime(activeTeam.lastUpload.createdAt) : 'noch keiner'}</strong>
              </div>
            </div>

            <div className="tabs">
              <button className={activeTab === 'tracker' ? 'tab active' : 'tab'} onClick={() => setActiveTab('tracker')}>
                Tracker
              </button>
              <button className={activeTab === 'upload' ? 'tab active' : 'tab'} onClick={() => setActiveTab('upload')}>
                Foto hochladen
              </button>
              <button className={activeTab === 'status' ? 'tab active' : 'tab'} onClick={() => setActiveTab('status')}>
                Status
              </button>
            </div>

            {activeTab === 'tracker' ? (
              <div className="tracker-panel">
                <div className="radar">
                  <div className="radar-ring radar-ring-one" />
                  <div className="radar-ring radar-ring-two" />
                  <div className="radar-core">Checkpoint</div>
                  {markerPositions.length > 0 ? (
                    markerPositions.map((marker) => (
                      <div key={marker.id} className="radar-dot" style={{ transform: `translate(${marker.x}px, ${marker.y}px)`, borderColor: marker.color }}>
                        <span>{marker.label}</span>
                      </div>
                    ))
                  ) : (
                    <div className="radar-empty">Noch keine Live-Referenz vorhanden</div>
                  )}
                </div>
                <div className="tracker-meta">
                  <div className="mini-card">
                    <span className="card-label">Phase</span>
                    <strong>{currentState?.status ?? 'offline'}</strong>
                  </div>
                  <div className="mini-card">
                    <span className="card-label">Nächster Zielpunkt</span>
                    <strong>{checkpointLabel}</strong>
                  </div>
                  <div className="mini-card">
                    <span className="card-label">Letztes GPS</span>
                    <strong>{formatTime(location?.time)}</strong>
                  </div>
                </div>
              </div>
            ) : null}

            {activeTab === 'upload' ? (
              <div className="upload-panel">
                <label>
                  Foto auswählen
                  <input type="file" accept="image/*" capture="environment" onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    setSelectedPhoto(file);
                    if (file) {
                      const previewUrl = URL.createObjectURL(file);
                      setPhotoPreview(previewUrl);
                    } else {
                      setPhotoPreview(null);
                    }
                  }} />
                </label>
                {photoPreview ? <img className="photo-preview" src={photoPreview} alt="Vorschau" /> : <div className="photo-placeholder">Noch kein Foto ausgewählt</div>}
                <label>
                  Bildbeschreibung
                  <input value={photoCaption} onChange={(event) => setPhotoCaption(event.target.value)} placeholder="z. B. Gleiche Stelle, neuer Blickwinkel" />
                </label>
                <div className="button-row">
                  <button className="primary" disabled={isBusy} onClick={submitPhoto}>
                    {isBusy ? 'Wird hochgeladen…' : 'Foto hochladen'}
                  </button>
                  <button className="secondary" onClick={sendManualPosition}>
                    Manuelle Position senden
                  </button>
                </div>
                <div className="form-grid two-col">
                  <label>
                    Latitude
                    <input value={manualLat} onChange={(event) => setManualLat(event.target.value)} />
                  </label>
                  <label>
                    Longitude
                    <input value={manualLng} onChange={(event) => setManualLng(event.target.value)} />
                  </label>
                </div>
              </div>
            ) : null}

            {activeTab === 'status' ? (
              <div className="status-panel">
                <div className="mini-card">
                  <span className="card-label">Aktive Phase</span>
                  <strong>{currentState?.status ?? 'offline'}</strong>
                </div>
                <div className="mini-card">
                  <span className="card-label">Letzter Teamwechsel</span>
                  <strong>{formatDateTime(currentState?.currentCheckpoint?.uploadedAt)}</strong>
                </div>
                <div className="mini-card">
                  <span className="card-label">Mitglieder online</span>
                  <strong>{activeTeam?.memberCount ?? 0}</strong>
                </div>
              </div>
            ) : null}
          </article>

          <aside className="side-column">
            <article className="panel">
              <h3>Live-Übersicht</h3>
              <div className="team-list compact">
                {currentState
                  ? (['red', 'blue'] as TeamId[]).map((id) => {
                      const team = currentState.teams[id];
                      const stale = team.locationAgeMs !== null && team.locationAgeMs > currentState.settings.staleLocationMs;
                      return (
                        <div className="team-card small" key={id}>
                          <div className="team-topline">
                            <strong>{team.name}</strong>
                            <span className="dot" style={{ background: team.color }} />
                          </div>
                          <p>Checkpoints: {team.checkpoints}</p>
                          <p>Position: {team.lastPosition ? `${team.lastPosition.lat.toFixed(4)}, ${team.lastPosition.lng.toFixed(4)}` : 'keine'}</p>
                          <p className={stale ? 'warning-text' : ''}>Alter: {formatRelative(team.locationAgeMs)}</p>
                        </div>
                      );
                    })
                  : null}
              </div>
            </article>

            <article className="panel">
              <h3>Letzte Events</h3>
              <div className="event-list">
                {currentState?.events.slice(0, 8).map((event) => (
                  <div className="event-item" key={event.id}>
                    <span>{formatTime(event.time)}</span>
                    <p>{event.message}</p>
                  </div>
                ))}
              </div>
            </article>
          </aside>
        </section>
      ) : null}

      {isAdmin ? (
        <section className="dashboard-grid admin-grid">
          <article className="panel focus-panel">
            <div className="section-head">
              <div>
                <p className="card-label">Admin-Dashboard</p>
                <h2>Live-Tracking und Anti-Cheat</h2>
              </div>
              <div className="button-row tight">
                <button className="secondary" onClick={() => setMode('player')}>Zur Spieleransicht</button>
                <button className="danger" onClick={resetGame}>Reset</button>
              </div>
            </div>

            <div className="admin-banner-grid">
              <div className="mini-card">
                <span className="card-label">Startteam</span>
                <strong>{TEAM_META[currentState?.leadingTeamId ?? 'red'].name}</strong>
              </div>
              <div className="mini-card">
                <span className="card-label">Aktives Team</span>
                <strong>{TEAM_META[currentState?.activeTeamId ?? 'red'].name}</strong>
              </div>
              <div className="mini-card">
                <span className="card-label">Vorsprung</span>
                <strong>{currentState?.headStartMinutes ?? 5} Minuten</strong>
              </div>
            </div>

            <div className="form-grid admin-form">
              <label>
                Admin-Token
                <input value={adminToken} onChange={(event) => setAdminToken(event.target.value)} />
              </label>
              <label>
                Vorsprung in Minuten
                <input value={adminHeadStart} onChange={(event) => setAdminHeadStart(event.target.value)} />
              </label>
              <label>
                Team Rot Name
                <input value={adminInputRed} onChange={(event) => setAdminInputRed(event.target.value)} />
              </label>
              <label>
                Team Blau Name
                <input value={adminInputBlue} onChange={(event) => setAdminInputBlue(event.target.value)} />
              </label>
              <label>
                Führendes Team
                <select value={adminLeader} onChange={(event) => setAdminLeader(event.target.value as TeamId)}>
                  <option value="red">Team Rot</option>
                  <option value="blue">Team Blau</option>
                </select>
              </label>
            </div>
            <div className="button-row">
              <button className="primary" onClick={applyAdminConfig}>Konfiguration speichern</button>
              <button className="primary" onClick={startGame}>Spiel starten</button>
            </div>

            <div className="status-card-grid admin-stats">
              {currentState
                ? (['red', 'blue'] as TeamId[]).map((id) => {
                    const team = currentState.teams[id];
                    const checkpoint = currentState.currentCheckpoint?.location;
                    const distance = checkpoint && team.lastPosition ? distanceMeters(checkpoint, team.lastPosition) : null;
                    const stale = team.locationAgeMs !== null && team.locationAgeMs > currentState.settings.staleLocationMs;
                    return (
                      <div key={id} className={`team-card ${stale ? 'flagged' : ''}`}>
                        <div className="team-topline">
                          <strong>{team.name}</strong>
                          <span className="dot" style={{ background: team.color }} />
                        </div>
                        <p>Mitglieder online: {team.memberCount}</p>
                        <p>Checkpoints: {team.checkpoints}</p>
                        <p>Letzter Standort: {team.lastPosition ? `${team.lastPosition.lat.toFixed(5)}, ${team.lastPosition.lng.toFixed(5)}` : 'keiner'}</p>
                        <p>Abstand zum Ziel: {formatDistance(distance)}</p>
                        <p className={stale ? 'warning-text' : ''}>Standort-Alter: {formatRelative(team.locationAgeMs)}</p>
                        <p>Flags: {team.flags.length}</p>
                        {team.lastUpload?.dataUrl ? <img className="photo-preview admin-preview" src={team.lastUpload.dataUrl} alt={`${team.name} Upload`} /> : null}
                      </div>
                    );
                  })
                : null}
            </div>
          </article>

          <aside className="side-column admin-side">
            <article className="panel">
              <h3>Checkpoint-Radar</h3>
              <div className="radar radar-admin">
                <div className="radar-ring radar-ring-one" />
                <div className="radar-ring radar-ring-two" />
                <div className="radar-core">{currentState?.currentCheckpoint ? 'Ziel' : 'Leerer Start'}</div>
                {markerPositions.length > 0 ? markerPositions.map((marker) => (
                  <div key={marker.id} className="radar-dot" style={{ transform: `translate(${marker.x}px, ${marker.y}px)`, borderColor: marker.color }}>
                    <span>{marker.label}</span>
                  </div>
                )) : <div className="radar-empty">Noch kein Zielpunkt vorhanden</div>}
              </div>
              <p className="muted">Der Punkt in der Mitte ist der letzte gültige Upload. Die Dots zeigen die Teams relativ dazu.</p>
            </article>

            <article className="panel">
              <h3>Event-Stream</h3>
              <div className="event-list tall">
                {currentState?.events.map((event) => (
                  <div className="event-item" key={event.id}>
                    <span>{formatTime(event.time)}</span>
                    <p>{event.message}</p>
                  </div>
                ))}
              </div>
            </article>
          </aside>
        </section>
      ) : null}

      <footer className="footer">
        <span>{connected ? 'Socket verbunden' : 'Socket getrennt'}</span>
        <span>Maximale Upload-Distanz: {currentState?.settings.captureRadiusMeters ?? 45} m</span>
        <span>Admin-Token lokal im Browser gespeichert</span>
      </footer>
    </main>
  );
}