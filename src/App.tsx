import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import QRCode from 'qrcode';

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

function QrCodeView({ code, teamId }: { code: string; teamId: TeamId }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const teamUrl = new URL(window.location.href);
  teamUrl.search = '';
  teamUrl.searchParams.set('code', code);

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, teamUrl.toString(), {
        width: 180,
        margin: 2,
        color: {
          dark: '#08111f',
          light: '#ffffff',
        },
      });
    }
  }, [code, teamUrl]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <canvas ref={canvasRef} />
      <strong>{code}</strong>
    </div>
  );
}

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

function formatDuration(ms?: number | null) {
  if (ms === null || ms === undefined) {
    return '–';
  }

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatCountdown(ms?: number | null) {
  if (ms === null || ms === undefined) {
    return '–';
  }


  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
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

function buildUrl(mode: ViewMode, teamId?: TeamId) {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  if (teamId) {
    url.searchParams.set('team', teamId);
  }
  return url;
}

export default function App() {
  const savedTeamCode = window.localStorage.getItem('outside-game-team-code') || '';
  const savedSessionRaw = window.localStorage.getItem('outside-game-session');
  const socketRef = useRef<Socket | null>(null);
  const autoJoinAttemptedRef = useRef(false);
  const lastAlertEventIdRef = useRef<string | null>(null);
  const headStartAlertedRef = useRef(false);
  const alertAudioRef = useRef<HTMLAudioElement | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [mode, setMode] = useState<ViewMode>(() => {
    const path = window.location.pathname;
    if (path === '/admin') {
      return 'admin';
    }
    if (savedSessionRaw) {
      try {
        const parsed = JSON.parse(savedSessionRaw) as { mode?: ViewMode; code?: string; name?: string };
        if (parsed.mode === 'player' && parsed.code) {
          return 'player';
        }
      } catch {
        // ignore malformed session data
      }
    }
    if (savedTeamCode) {
      return 'player';
    }
    return 'intro';
  });
  const [teamId, setTeamId] = useState<TeamId>('red');
  const [name, setName] = useState(() => window.localStorage.getItem('outside-game-name') || '');
  const [gameCode, setGameCode] = useState(() => {
    if (savedSessionRaw) {
      try {
        const parsed = JSON.parse(savedSessionRaw) as { code?: string };
        return parsed.code || '';
      } catch {
        return savedTeamCode;
      }
    }
    return savedTeamCode;
  });
  const [adminPassword, setAdminPassword] = useState(() => window.localStorage.getItem('outside-game-admin-password') || '');
  const [adminPasswordSet, setAdminPasswordSet] = useState<boolean | null>(null);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState('');
  const [manualLat, setManualLat] = useState('48.137');
  const [manualLng, setManualLng] = useState('11.575');
  const [selectedPhoto, setSelectedPhoto] = useState<File | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [location, setLocation] = useState<Position | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [adminInputRed, setAdminInputRed] = useState('Team Rot');
  const [adminInputBlue, setAdminInputBlue] = useState('Team Blau');
  const [adminHeadStart, setAdminHeadStart] = useState('5');
  const [adminLeader, setAdminLeader] = useState<TeamId>('red');
  const [locationPermission, setLocationPermission] = useState<'unknown' | 'prompting' | 'granted' | 'denied'>('unknown');
  const [adminCodes, setAdminCodes] = useState<Partial<Record<TeamId, string>>>({});
  const [headStartRemaining, setHeadStartRemaining] = useState<string | null>(null);

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
    alertAudioRef.current = new Audio('/alert.mp3');
    alertAudioRef.current.preload = 'auto';
  }, []);

  useEffect(() => {
    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
    });

    socket.on('disconnect', () => {
      setConnected(false);
      autoJoinAttemptedRef.current = false;
    });
    socket.on('state:update', (nextState: Snapshot) => setSnapshot(nextState));
    socket.on('admin:update', (nextState: Snapshot) => setSnapshot(nextState));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (window.location.pathname === '/admin') {
      return;
    }

    const session = window.localStorage.getItem('outside-game-session');
    if (!session) {
      return;
    }

    try {
      const parsed = JSON.parse(session) as { mode?: ViewMode; code?: string; name?: string; teamId?: TeamId };
      if (parsed.mode === 'player' && parsed.code) {
        if (!gameCode) {
          setGameCode(parsed.code);
        }
        if (parsed.name && !name) {
          setName(parsed.name);
        }
        if (parsed.teamId === 'red' || parsed.teamId === 'blue') {
          setTeamId(parsed.teamId);
        }
        setMode('player');
      }
    } catch {
      // ignore malformed session data
    }
  }, []);

  useEffect(() => {
    if (connected && isPlayer && gameCode.trim() && !autoJoinAttemptedRef.current) {
      autoJoinAttemptedRef.current = true;
      joinAsPlayer();
    }
  }, [connected, isPlayer, gameCode]);

  useEffect(() => {
    const currentEventId = currentState?.events?.[0]?.id ?? null;
    if (!currentEventId) {
      return;
    }

    if (lastAlertEventIdRef.current === null) {
      lastAlertEventIdRef.current = currentEventId;
      return;
    }

    if (lastAlertEventIdRef.current === currentEventId) {
      return;
    }

    lastAlertEventIdRef.current = currentEventId;
    const eventType = currentState?.events?.[0]?.type;

    const shouldAlert = eventType === 'game-start' || eventType === 'photo-upload';

    if (shouldAlert) {
      const audio = alertAudioRef.current;
      if (audio) {
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
      }
    }
  }, [currentState?.events?.[0]?.id]);

  useEffect(() => {
    if (currentState?.status !== 'head_start' || !currentState.headStartEndsAt) {
      setHeadStartRemaining(null);
      return undefined;
    }

    const interval = setInterval(() => {
      const endsAt = new Date(currentState.headStartEndsAt!).getTime();
      const remaining = endsAt - Date.now();
      if (remaining <= 0) {
        setHeadStartRemaining(null);
        if (!headStartAlertedRef.current) {
          const audio = alertAudioRef.current;
          if (audio) {
            audio.currentTime = 0;
            void audio.play().catch(() => undefined);
          }
          headStartAlertedRef.current = true;
        }
      } else {
        setHeadStartRemaining(formatDuration(remaining));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [currentState?.status, currentState?.headStartEndsAt]);

  // check whether an admin password has been set on the server
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/admin/password');
        const j = await res.json();
        setAdminPasswordSet(Boolean(j.set));
      } catch (e) {
        setAdminPasswordSet(null);
      }
    };
    check();
  }, []);

  useEffect(() => {
    if (mode !== 'intro' && mode !== 'player') {
      return undefined;
    }
    requestLocationAccess();
  }, [mode]);

  const requestLocationAccess = () => {
    if (!navigator.geolocation) {
      setLocationPermission('denied');
      setMessage('Dieser Browser unterstützt keinen Standortzugriff.');
      return;
    }

    setLocationPermission('prompting');
    navigator.geolocation.getCurrentPosition(
      (result) => {
        setLocationPermission('granted');
        setLocation({
          lat: result.coords.latitude,
          lng: result.coords.longitude,
          accuracy: result.coords.accuracy,
          heading: result.coords.heading ?? 0,
          speed: result.coords.speed ?? 0,
          time: new Date().toISOString(),
        });
      },
      () => {
        setLocationPermission('denied');
        setMessage('Standortzugriff bitte erlauben, bevor du das Spiel startest.');
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  };

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

  const joinAsPlayer = () => {
    const code = gameCode.trim().toUpperCase();
    if (!code) {
      setMessage('Bitte einen Spielcode eingeben.');
      return;
    }

    setMode('player');
    window.localStorage.setItem('outside-game-name', name || 'Spieler');
    const nextUrl = buildUrl('player');
    window.history.replaceState({}, '', nextUrl.toString());
    // send join with code
    socketRef.current?.emit('join', { role: 'player', code, name }, (res: any) => {
      if (!res || !res.ok) {
        setMessage(res?.message || 'Beitritt fehlgeschlagen.');
        setMode('intro');
      } else {
        setSnapshot(res.state);
        if (res.assignedTeam === 'red' || res.assignedTeam === 'blue') {
          setTeamId(res.assignedTeam);
          window.localStorage.setItem('outside-game-team-code', code);
        }
        window.localStorage.setItem('outside-game-session', JSON.stringify({ mode: 'player', code, name, teamId: res.assignedTeam || teamId }));
        autoJoinAttemptedRef.current = true;
        setMessage(`Du bist Team ${res.assignedTeam || 'rot'}.`);
      }
    });
  };

  const joinAsAdmin = () => {
    if (!adminPassword) {
      setMessage('Bitte zuerst Passwort setzen oder einloggen auf /admin');
      return;
    }
    setMode('admin');
    window.localStorage.setItem('outside-game-admin-password', adminPassword);
    window.history.replaceState({}, '', '/admin');
    socketRef.current?.emit('join', { role: 'admin', name: 'Admin', password: adminPassword }, (res: any) => {
      if (res && res.ok && res.state) {
        setSnapshot(res.state);
        setIsAdminAuthenticated(true);
      } else setMessage(res?.message || 'Admin-Login fehlgeschlagen.');
    });
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
        password: adminPassword,
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

  const createCode = (teamId: TeamId) => {
    socketRef.current?.emit('admin:create-code', { password: adminPassword, teamId }, (res: any) => {
      if (res && res.ok) {
        setMessage(`Neuer ${teamId === 'red' ? 'Rot' : 'Blau'}-Code: ${res.code}`);
        setAdminCodes((current) => ({ ...current, [teamId]: res.code }));
        // refresh admin state
        socketRef.current?.emit('join', { role: 'admin', name: 'Admin', password: adminPassword }, (r: any) => r && r.state && setSnapshot(r.state));
      } else {
        setMessage(res?.message || 'Code-Erstellung fehlgeschlagen.');
      }
    });
  };

  const resetGame = () => {
    socketRef.current?.emit('admin:reset', { password: adminPassword }, (response: JoinResult) => {
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
        password: adminPassword,
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

  const introHint = locationPermission === 'prompting'
    ? 'Standort wird angefragt…'
    : locationPermission === 'granted'
      ? 'Standort erlaubt'
      : locationPermission === 'denied'
        ? (window.isSecureContext ? 'Standort bitte erlauben' : 'Standort braucht HTTPS oder localhost')
        : 'Standortzugriff';

  let content = null;

  if (isPlayer) {
    content = (
      <section className="panel" style={{ maxWidth: 560, margin: '24px auto', display: 'grid', gap: 14 }}>
        <div className="section-head">
          <div>
            <p className="card-label">Team</p>
            <h2>{activeTeam?.name ?? TEAM_META[teamId].name}</h2>
          </div>
          <span className="status-chip" style={{ borderColor: TEAM_META[teamId].accent, color: TEAM_META[teamId].accent }}>{TEAM_META[teamId].label}</span>
        </div>

        <div className="status-card-grid">
          <div className="mini-card"><span className="card-label">Standort</span><strong>{locationPermission === 'granted' ? 'erlaubt' : introHint}</strong></div>
          <div className="mini-card"><span className="card-label">Letztes Foto</span><strong>{activeTeam?.lastUpload ? formatDateTime(activeTeam.lastUpload.createdAt) : 'noch keines'}</strong></div>
          <div className="mini-card"><span className="card-label">Zeit</span><strong>{formatTime(location?.time)}</strong></div>
        </div>

        {currentState?.status === 'head_start' && (
          <div className="card">
            <h3>Vorsprung aktiv</h3>
            <div className="countdown" style={{ fontSize: '2.5rem', margin: '1rem 0' }}>{headStartRemaining}</div>
            <p>Macht euch bereit, das andere Team auszuspionieren, sobald das Spiel live geht.</p>
          </div>
        )}

        {currentState?.status === 'live' && (
          <div className="upload-panel">
            <label className="button primary">
              <span className="material-icons">photo_camera</span>
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
            <div className="button-row">
              <button className="primary" disabled={isBusy || !selectedPhoto} onClick={submitPhoto}>
                <span className="material-icons">upload</span>
                {isBusy ? 'Wird hochgeladen…' : 'Als da bestätigen'}
              </button>
              <button className="secondary" onClick={requestLocationAccess}>
                <span className="material-icons">my_location</span>
                Standort freigeben
              </button>
            </div>
            <p className="muted">{currentState?.status === 'head_start' ? 'Der Vorsprung läuft noch.' : 'Ein Foto reicht zur Bestätigung.'}</p>
          </div>
        )}
      </section>
    );
  } else if (isAdmin) {
    if (adminPasswordSet === null) {
      content = <section className="panel" style={{ maxWidth: 420, margin: '24px auto' }}>Prüfe Admin-Status…</section>;
    } else if (!adminPasswordSet) {
      content = (
        <section className="panel" style={{ maxWidth: 420, margin: '24px auto', display: 'grid', gap: 8 }}>
          <label>Admin-Passwort setzen (mind. 4 Zeichen)
            <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" onClick={async () => {
              try {
                const res = await fetch('/admin/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: adminPassword }) });
                const j = await res.json();
                if (res.ok && j.ok) {
                  window.localStorage.setItem('outside-game-admin-password', adminPassword);
                  setAdminPasswordSet(true);
                  socketRef.current?.emit('join', { role: 'admin', name: 'Admin', password: adminPassword }, (r: any) => {
                    if (r && r.ok && r.state) { setSnapshot(r.state); setIsAdminAuthenticated(true); }
                    else setMessage(r?.message || 'Join fehlgeschlagen.');
                  });
                } else {
                  setMessage(j.message || 'Setzen fehlgeschlagen.');
                }
              } catch {
                setMessage('Fehler beim Setzen des Passworts.');
              }
            }}>Setzen und anmelden</button>
          </div>
        </section>
      );
    } else if (!isAdminAuthenticated) {
      content = (
        <section className="panel" style={{ maxWidth: 420, margin: '24px auto', display: 'grid', gap: 8 }}>
          <label>Admin-Passwort
            <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" onClick={() => {
              window.localStorage.setItem('outside-game-admin-password', adminPassword);
              socketRef.current?.emit('join', { role: 'admin', name: 'Admin', password: adminPassword }, (r: any) => {
                if (r && r.ok && r.state) { setSnapshot(r.state); setIsAdminAuthenticated(true); }
                else setMessage(r?.message || 'Login fehlgeschlagen.');
              });
            }}>Login</button>
          </div>
        </section>
      );
    } else {
      content = (
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
              <div className="mini-card"><span className="card-label">Startteam</span><strong>{TEAM_META[currentState?.leadingTeamId ?? 'red'].name}</strong></div>
              <div className="mini-card"><span className="card-label">Aktives Team</span><strong>{TEAM_META[currentState?.activeTeamId ?? 'red'].name}</strong></div>
              <div className="mini-card"><span className="card-label">Vorsprung</span><strong>{currentState?.headStartMinutes ?? 5} Minuten</strong></div>
            </div>

            <div className="form-grid admin-form">
              <label>Admin-Passwort<input value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} /></label>
              <label>Vorsprung in Minuten<input value={adminHeadStart} onChange={(event) => setAdminHeadStart(event.target.value)} /></label>
              <label>Team Rot Name<input value={adminInputRed} onChange={(event) => setAdminInputRed(event.target.value)} /></label>
              <label>Team Blau Name<input value={adminInputBlue} onChange={(event) => setAdminInputBlue(event.target.value)} /></label>
              <label>Führendes Team
                <select value={adminLeader} onChange={(event) => setAdminLeader(event.target.value as TeamId)}>
                  <option value="red">Team Rot</option>
                  <option value="blue">Team Blau</option>
                </select>
              </label>
            </div>

            <div className="button-row">
              <button className="primary" onClick={applyAdminConfig}>Konfiguration speichern</button>
              <button className="primary" onClick={startGame}><span className="material-icons">play_arrow</span>Spiel starten</button>
              <button className="primary" onClick={() => createCode('red')}>Code Rot</button>
              <button className="primary" onClick={() => createCode('blue')}>Code Blau</button>
            </div>

            <div className="status-card-grid">
              <div className="mini-card"><span className="card-label">Rot-Code</span><strong>{adminCodes.red || 'noch keiner'}</strong></div>
              <div className="mini-card"><span className="card-label">Blau-Code</span><strong>{adminCodes.blue || 'noch keiner'}</strong></div>
            </div>

            <div className="status-card-grid admin-stats">
              {currentState ? (['red', 'blue'] as TeamId[]).map((id) => {
                const team = currentState.teams[id];
                const checkpoint = currentState.currentCheckpoint?.location;
                const distance = checkpoint && team.lastPosition ? distanceMeters(checkpoint, team.lastPosition) : null;
                const stale = team.locationAgeMs !== null && team.locationAgeMs > currentState.settings.staleLocationMs;
                return (
                  <div key={id} className={`team-card ${stale ? 'flagged' : ''}`}>
                    <div className="team-topline"><strong>{team.name}</strong><span className="dot" style={{ background: team.color }} /></div>
                    <p>Mitglieder online: {team.memberCount}</p>
                    <p>Checkpoints: {team.checkpoints}</p>
                    <p>Letzter Standort: {team.lastPosition ? `${team.lastPosition.lat.toFixed(5)}, ${team.lastPosition.lng.toFixed(5)}` : 'keiner'}</p>
                    <p>Abstand zum Ziel: {formatDistance(distance)}</p>
                    <p className={stale ? 'warning-text' : ''}>Standort-Alter: {formatRelative(team.locationAgeMs)}</p>
                    <p>Flags: {team.flags.length}</p>
                    {team.lastUpload?.dataUrl ? <img className="photo-preview admin-preview" src={team.lastUpload.dataUrl} alt={`${team.name} Upload`} /> : null}
                  </div>
                );
              }) : null}
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
                  <div key={marker.id} className="radar-dot" style={{ transform: `translate(${marker.x}px, ${marker.y}px)`, borderColor: marker.color }}><span>{marker.label}</span></div>
                )) : <div className="radar-empty">Noch kein Zielpunkt vorhanden</div>}
              </div>
              <p className="muted">Der Punkt in der Mitte ist der letzte gültige Upload. Die Dots zeigen die Teams relativ dazu.</p>
            </article>

            <article className="panel">
              <h3>Event-Stream</h3>
              <div className="event-list tall">
                {currentState?.events.map((event) => (
                  <div className="event-item" key={event.id}><span>{formatTime(event.time)}</span><p>{event.message}</p></div>
                ))}
              </div>
            </article>
          </aside>
        </section>
      );
    }
  }

  return (
    <main className="shell">
      {mode === 'intro' ? (
        <section className="panel" style={{ display: 'grid', gap: 8, maxWidth: 420, margin: '32px auto' }}>
          <label style={{ display: 'contents' }}>
            <input value={gameCode} onChange={(e) => setGameCode(e.target.value)} placeholder="Spielcode" autoFocus />
          </label>
          <div className="pill">{introHint}</div>
          <div className="button-row">
            <button className="secondary" onClick={requestLocationAccess}>Standort freigeben</button>
            <button className="primary" onClick={joinAsPlayer}>Beitreten</button>
          </div>
        </section>
      ) : null}

      {message ? <div className="banner">{message}</div> : null}
      {content}

      <footer className="footer">
        <span>{connected ? 'Socket verbunden' : 'Socket getrennt'}</span>
      </footer>
    </main>
  );
}