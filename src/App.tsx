import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import QRCode from 'qrcode';
import 'leaflet/dist/leaflet.css';

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

type CheckpointPhoto = {
  id: string;
  teamId: TeamId;
  teamName: string;
  location: Position | null;
  uploadedAt: string;
  caption: string;
  preview: string | null;
};

type PendingReview = {
  id: string;
  reviewTeamId: TeamId;
  uploadTeamId: TeamId;
  checkpoint: CheckpointPhoto;
};

type Snapshot = {
  status: 'lobby' | 'head_start' | 'live' | 'review';
  leadingTeamId: TeamId;
  activeTeamId: TeamId;
  headStartMinutes: number;
  headStartEndsAt: string | null;
  startedAt: string | null;
  currentCheckpoint: CheckpointPhoto | null;
  pendingReview: PendingReview | null;
  events: Array<{ id: string; type: string; message: string; details: Record<string, unknown>; time: string }>;
  settings: {
    captureRadiusMeters: number;
    staleLocationMs: number;
    impossibleSpeedKmh: number;
  };
  teams: Record<TeamId, TeamSummary>;
  joinCodes?: Array<{ code: string; teamId: TeamId; createdAt: string }>;
};

type JoinResult = { ok: boolean; message?: string; state?: Snapshot; assignedTeam?: TeamId };
type UploadResult = JoinResult;

const TEAM_META: Record<TeamId, { name: string; accent: string; label: string }> = {
  red: { name: 'Team Rot', accent: '#ff6b6b', label: 'Rot' },
  blue: { name: 'Team Blau', accent: '#4dabf7', label: 'Blau' },
};

function QrCodeView({ code, teamId }: { code: string; teamId: TeamId }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const teamMeta = TEAM_META[teamId];
  const teamUrl = new URL(window.location.origin);
  teamUrl.pathname = '/';
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
    <div className="qr-card">
      <div className="qr-card-head">
        <span className="material-icons">qr_code_2</span>
        <div>
          <p className="card-label">{teamMeta.name}</p>
          <strong>{code || 'Noch kein Code'}</strong>
        </div>
      </div>
      <canvas ref={canvasRef} />
      <p className="muted">Scannt direkt ins Join-Feld statt den Code einzutippen.</p>
    </div>
  );
}

function MapBoundsUpdater({ points, center }: { points: Array<[number, number]>; center: [number, number] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) {
      map.setView(center, 14);
      return;
    }

    map.fitBounds(points, { padding: [40, 40], maxZoom: 17 });
  }, [center, map, points]);

  return null;
}

function OpenStreetMapView({ state }: { state: Snapshot | null }) {
  const fallbackCenter: [number, number] = [48.137154, 11.576124];

  const center = useMemo<[number, number]>(() => {
    const checkpoint = state?.currentCheckpoint?.location;
    if (checkpoint) {
      return [checkpoint.lat, checkpoint.lng];
    }

    const knownPositions = (['red', 'blue'] as TeamId[])
      .map((teamId) => state?.teams[teamId]?.lastPosition)
      .filter(Boolean) as Position[];

    if (knownPositions.length > 0) {
      const sumLat = knownPositions.reduce((sum, position) => sum + position.lat, 0);
      const sumLng = knownPositions.reduce((sum, position) => sum + position.lng, 0);
      return [sumLat / knownPositions.length, sumLng / knownPositions.length];
    }

    return fallbackCenter;
  }, [state]);

  const points = useMemo(() => {
    const nextPoints: Array<{ id: string; position: [number, number]; label: string; color: string; type: 'team' | 'checkpoint' | 'review' }> = [];

    if (state?.currentCheckpoint?.location) {
      nextPoints.push({
        id: 'checkpoint',
        position: [state.currentCheckpoint.location.lat, state.currentCheckpoint.location.lng],
        label: `Ziel: ${state.currentCheckpoint.teamName}`,
        color: '#f9c74f',
        type: 'checkpoint',
      });
    }

    if (state?.pendingReview?.checkpoint.location) {
      nextPoints.push({
        id: 'review',
        position: [state.pendingReview.checkpoint.location.lat, state.pendingReview.checkpoint.location.lng],
        label: 'Prüfung wartet',
        color: '#ff7b7b',
        type: 'review',
      });
    }

    const latestPinEvent = state?.events.find((event) => event.type === 'admin-pin' && event.details && typeof event.details === 'object') || null;
    const latestPinDetails = latestPinEvent?.details as { label?: string; location?: { lat?: number; lng?: number } } | undefined;
    const pinLocation = latestPinDetails?.location || null;
    if (pinLocation && Number.isFinite(pinLocation.lat) && Number.isFinite(pinLocation.lng)) {
      nextPoints.push({
        id: 'admin-pin',
        position: [Number(pinLocation.lat), Number(pinLocation.lng)],
        label: String(latestPinDetails?.label || latestPinEvent?.message || 'Standortpin'),
        color: '#7ee6a7',
        type: 'checkpoint',
      });
    }

    (['red', 'blue'] as TeamId[]).forEach((teamId) => {
      const position = state?.teams[teamId]?.lastPosition;
      if (!position) {
        return;
      }

      nextPoints.push({
        id: teamId,
        position: [position.lat, position.lng],
        label: state?.teams[teamId]?.name || teamId,
        color: state?.teams[teamId]?.color || '#ffffff',
        type: 'team',
      });
    });

    return nextPoints;
  }, [state]);

  return (
    <div className="map-shell">
      <MapContainer center={center} zoom={14} scrollWheelZoom className="leaflet-map">
        <MapBoundsUpdater points={points.map((point) => point.position)} center={center} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {points.map((point) => (
          <CircleMarker
            key={point.id}
            center={point.position}
            radius={point.type === 'checkpoint' ? 12 : point.type === 'review' ? 10 : 8}
            pathOptions={{
              color: point.color,
              fillColor: point.color,
              fillOpacity: point.type === 'checkpoint' ? 0.7 : 0.5,
              weight: 3,
            }}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={1} permanent={point.type === 'checkpoint'}>
              {point.label}
            </Tooltip>
            <Popup>{point.label}</Popup>
          </CircleMarker>
        ))}
      </MapContainer>
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

function buildUrl(mode: ViewMode, teamId?: TeamId) {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  if (teamId) {
    url.searchParams.set('team', teamId);
  }
  return url;
}

function readJoinCodeFromLocation() {
  const code = new URLSearchParams(window.location.search).get('code')?.trim().toUpperCase() || '';
  return code;
}

export default function App() {
  const savedTeamCode = window.localStorage.getItem('outside-game-team-code') || '';
  const savedSessionRaw = window.localStorage.getItem('outside-game-session');
  const urlJoinCode = readJoinCodeFromLocation();
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
    if (urlJoinCode) {
      return 'player';
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
    if (urlJoinCode) {
      return urlJoinCode;
    }
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
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
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
  const [adminTipTeam, setAdminTipTeam] = useState<'all' | TeamId>('all');
  const [adminTipText, setAdminTipText] = useState('');
  const [adminPinLabel, setAdminPinLabel] = useState('Standortpin');
  const [adminPinLat, setAdminPinLat] = useState('48.137');
  const [adminPinLng, setAdminPinLng] = useState('11.575');
  const [requestStatus, setRequestStatus] = useState<{ label: string; phase: 'sending' | 'waiting' | 'done' | 'error' | 'offline'; detail?: string } | null>(null);

  const isPlayer = mode === 'player';
  const isAdmin = mode === 'admin';

  const currentState = snapshot;
  const latestEvent = currentState?.events?.[0] ?? null;
  const activeTeam = currentState ? currentState.teams[teamId] : null;
  const targetCheckpoint = currentState?.currentCheckpoint?.location || null;
  const headStartSummary = useMemo(() => {
    if (!currentState || currentState.status !== 'head_start' || !currentState.headStartEndsAt) {
      return null;
    }

    const remainingMs = new Date(currentState.headStartEndsAt).getTime() - nowMs;
    return {
      remainingMs,
      remainingText: formatDuration(Math.max(0, remainingMs)),
      expired: remainingMs <= 0,
    };
  }, [currentState?.status, currentState?.headStartEndsAt, nowMs]);

  const viewStateText = useMemo(() => {
    if (!currentState) {
      return 'Warten auf Spielstatus…';
    }

    if (currentState.status === 'lobby') {
      return 'Spiel noch nicht gestartet';
    }

    if (currentState.status === 'head_start') {
      if (headStartSummary?.expired) {
        return `Vorsprung abgelaufen. Jetzt ist ${TEAM_META[currentState.activeTeamId].name} dran.`;
      }

      return `Vorsprung läuft für ${TEAM_META[currentState.leadingTeamId].name} · noch ${headStartSummary?.remainingText ?? '…'}`;
    }

    if (currentState.status === 'review') {
      return `Bild wird geprüft. Dran ist ${TEAM_META[currentState.activeTeamId].name}`;
    }

    return `Jagd läuft. Dran ist ${TEAM_META[currentState.activeTeamId].name}`;
  }, [currentState, headStartSummary?.expired, headStartSummary?.remainingText]);

  const latestAdminNotice = useMemo(() => {
    if (!currentState) {
      return null;
    }

    return currentState.events.find((event) => {
      if (event.type !== 'admin-tip' && event.type !== 'admin-pin') {
        return false;
      }

      const targetTeamId = event.details?.teamId;
      return !targetTeamId || targetTeamId === teamId;
    }) || null;
  }, [currentState, teamId]);

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
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const playImportantAlert = () => {
    const audio = alertAudioRef.current;
    if (audio) {
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    }
  };

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setRequestStatus({ label: 'Verbindung', phase: 'offline', detail: 'Gerät ist offline.' });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const sendTrackedRequest = <TResponse,>(
    label: string,
    eventName: string,
    payload: Record<string, unknown>,
    onSuccess: (response: TResponse) => void,
  ) => {
    if (!socketRef.current || !connected || !isOnline) {
      setRequestStatus({ label, phase: 'offline', detail: 'Gerät ist offline oder die Verbindung ist getrennt.' });
      setMessage('Gerät offline oder nicht verbunden.');
      return false;
    }

    setRequestStatus({ label, phase: 'sending', detail: 'Anfrage wird gesendet…' });
    const waitingTimer = window.setTimeout(() => {
      setRequestStatus((current) => (current && current.label === label ? { ...current, phase: 'waiting', detail: 'Anfrage ist unterwegs…' } : current));
    }, 600);

    const timeoutTimer = window.setTimeout(() => {
      setRequestStatus({ label, phase: 'offline', detail: 'Keine Antwort vom Server.' });
      setMessage('Keine Antwort vom Server erhalten.');
    }, 12_000);

    socketRef.current.emit(eventName, payload, (response: TResponse) => {
      window.clearTimeout(waitingTimer);
      window.clearTimeout(timeoutTimer);
      onSuccess(response);
      setRequestStatus({
        label,
        phase: (response as { ok?: boolean }).ok ? 'done' : 'error',
        detail: (response as { message?: string }).message || ((response as { ok?: boolean }).ok ? 'Anfrage bestätigt.' : 'Anfrage fehlgeschlagen.'),
      });
      window.setTimeout(() => setRequestStatus(null), 1800);
    });

    return true;
  };

  useEffect(() => {
    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setIsOnline(true);
    });

    socket.on('disconnect', () => {
      setConnected(false);
      autoJoinAttemptedRef.current = false;
      setRequestStatus((current) => (current ? { ...current, phase: 'offline', detail: 'Verbindung getrennt.' } : { label: 'Verbindung', phase: 'offline', detail: 'Verbindung getrennt.' }));
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
    if (!latestEvent?.id) {
      return;
    }

    if (lastAlertEventIdRef.current === null) {
      lastAlertEventIdRef.current = latestEvent.id;
      return;
    }

    if (lastAlertEventIdRef.current === latestEvent.id) {
      return;
    }

    lastAlertEventIdRef.current = latestEvent.id;

    if (latestEvent.type === 'game-start' || latestEvent.type === 'photo-upload' || latestEvent.type === 'photo-review-pending' || latestEvent.type === 'photo-approved' || latestEvent.type === 'photo-rejected') {
      playImportantAlert();
    }
  }, [latestEvent?.id, latestEvent?.type]);

  useEffect(() => {
    if (currentState?.status !== 'head_start' || !currentState.headStartEndsAt) {
      headStartAlertedRef.current = false;
      return undefined;
    }

    if (headStartSummary?.expired && !headStartAlertedRef.current) {
      playImportantAlert();
      headStartAlertedRef.current = true;
    }

    if (!headStartSummary?.expired) {
      headStartAlertedRef.current = false;
    }
  }, [currentState?.status, currentState?.headStartEndsAt, headStartSummary?.expired]);

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
    const requestSent = sendTrackedRequest<JoinResult>('Beitreten', 'join', { role: 'player', code, name }, (res) => {
      if (!res || !res.ok) {
        setMessage(res?.message || 'Beitritt fehlgeschlagen.');
        setMode('intro');
      } else {
        if (res.state) {
          setSnapshot(res.state);
        }
        if (res.assignedTeam === 'red' || res.assignedTeam === 'blue') {
          setTeamId(res.assignedTeam);
          window.localStorage.setItem('outside-game-team-code', code);
        }
        window.localStorage.setItem('outside-game-session', JSON.stringify({ mode: 'player', code, name, teamId: res.assignedTeam || teamId }));
        autoJoinAttemptedRef.current = true;
        setMessage(`Du bist Team ${res.assignedTeam || 'rot'}.`);
      }
    });

    if (!requestSent) {
      setMode('intro');
    }
  };

  const joinAsAdmin = () => {
    if (!adminPassword) {
      setMessage('Bitte zuerst Passwort setzen oder einloggen auf /admin');
      return;
    }
    setMode('admin');
    window.localStorage.setItem('outside-game-admin-password', adminPassword);
    window.history.replaceState({}, '', '/admin');
    const requestSent = sendTrackedRequest<JoinResult>('Admin-Login', 'join', { role: 'admin', name: 'Admin', password: adminPassword }, (res) => {
      if (res && res.ok && res.state) {
        setSnapshot(res.state);
        setIsAdminAuthenticated(true);
      } else setMessage(res?.message || 'Admin-Login fehlgeschlagen.');
    });

    if (!requestSent) {
      setMode('intro');
    }
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

      const requestSent = sendTrackedRequest<UploadResult>('Foto senden', 'player:photo', {
        name: selectedPhoto.name,
        dataUrl,
        location,
      }, (response) => {
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
      });

      if (!requestSent) {
        setIsBusy(false);
      }
    } catch (error) {
      setIsBusy(false);
      setMessage(error instanceof Error ? error.message : 'Upload fehlgeschlagen.');
    }
  };

  const sendReviewDecision = (action: 'accept' | 'reject') => {
    sendTrackedRequest<JoinResult>(action === 'accept' ? 'Bild annehmen' : 'Bild ablehnen', 'player:review', { action }, (response) => {
      if (response.ok && response.state) {
        setSnapshot(response.state);
        setMessage(action === 'accept' ? 'Bild angenommen.' : 'Bild abgelehnt.');
      } else {
        setMessage(response.message || 'Prüfung fehlgeschlagen.');
      }
    });
  };

  const sendAdminTip = () => {
    const text = adminTipText.trim();
    if (!text) {
      setMessage('Bitte einen Tipp eingeben.');
      return;
    }

    sendTrackedRequest<JoinResult>('Tipp senden', 'admin:tip', { password: adminPassword, message: text, teamId: adminTipTeam === 'all' ? null : adminTipTeam }, (response) => {
      if (response.ok && response.state) {
        setSnapshot(response.state);
        setMessage('Tipp gesendet.');
        setAdminTipText('');
      } else {
        setMessage(response.message || 'Tipp konnte nicht gesendet werden.');
      }
    });
  };

  const sendAdminPin = () => {
    const lat = Number(adminPinLat);
    const lng = Number(adminPinLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setMessage('Bitte gültige Pin-Koordinaten eingeben.');
      return;
    }

    sendTrackedRequest<JoinResult>('Standortpin senden', 'admin:pin', {
      password: adminPassword,
      label: adminPinLabel,
      lat,
      lng,
      teamId: adminTipTeam === 'all' ? null : adminTipTeam,
    }, (response) => {
      if (response.ok && response.state) {
        setSnapshot(response.state);
        setMessage('Standortpin gesendet.');
      } else {
        setMessage(response.message || 'Pin konnte nicht gesendet werden.');
      }
    });
  };

  const startGame = () => {
    sendTrackedRequest<JoinResult>('Spiel starten', 'admin:start', {
      password: adminPassword,
      leadingTeamId: adminLeader,
      headStartMinutes: Number(adminHeadStart),
    }, (response) => {
      if (response.ok && response.state) {
        setSnapshot(response.state);
        setMessage('Spiel gestartet.');
      } else {
        setMessage(response.message || 'Start fehlgeschlagen.');
      }
    });
  };

  const createCode = (teamId: TeamId) => {
    sendTrackedRequest<any>(teamId === 'red' ? 'Code Rot' : 'Code Blau', 'admin:create-code', { password: adminPassword, teamId }, (res) => {
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
    sendTrackedRequest<JoinResult>('Spiel zurücksetzen', 'admin:reset', { password: adminPassword }, (response) => {
      if (response.ok && response.state) {
        setSnapshot(response.state);
        setMessage('Spiel zurückgesetzt.');
      } else {
        setMessage(response.message || 'Reset fehlgeschlagen.');
      }
    });
  };

  const applyAdminConfig = () => {
    sendTrackedRequest<JoinResult>('Konfiguration speichern', 'admin:configure', {
      password: adminPassword,
      redName: adminInputRed,
      blueName: adminInputBlue,
      leadingTeamId: adminLeader,
      headStartMinutes: Number(adminHeadStart),
    }, (response) => {
      if (response.ok && response.state) {
        setSnapshot(response.state);
        setMessage('Konfiguration gespeichert.');
      } else {
        setMessage(response.message || 'Konfiguration fehlgeschlagen.');
      }
    });
  };

  const activeCheckpointDistance = useMemo(() => {
    if (!location || !targetCheckpoint) {
      return null;
    }

    return distanceMeters(location, targetCheckpoint);
  }, [location, targetCheckpoint]);

  const checkpointLabel = currentState?.currentCheckpoint
    ? `${currentState.currentCheckpoint.teamName} · ${formatDateTime(currentState.currentCheckpoint.uploadedAt)}`
    : 'Noch kein Startfoto hochgeladen';
  
  const isActiveTeamTurn = currentState?.activeTeamId === teamId;
  const pendingReview = currentState?.pendingReview;
  const isReviewTeam = pendingReview?.reviewTeamId === teamId;
  const canUploadPhoto = Boolean(
    currentState && (
      (currentState.status === 'head_start' && headStartSummary?.expired && teamId === currentState.leadingTeamId) ||
      (currentState.status === 'live' && isActiveTeamTurn && !pendingReview)
    ),
  );

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
            <p className="card-label"><span className="material-icons">sports_soccer</span> Team</p>
            <h2>{activeTeam?.name ?? TEAM_META[teamId].name}</h2>
          </div>
          <span className="status-chip" style={{ borderColor: TEAM_META[teamId].accent, color: TEAM_META[teamId].accent }}>{TEAM_META[teamId].label}</span>
        </div>

        <div className="status-card-grid">
          <div className="mini-card"><span className="card-label"><span className="material-icons">my_location</span> Standort</span><strong>{locationPermission === 'granted' ? 'erlaubt' : introHint}</strong></div>
          <div className="mini-card"><span className="card-label"><span className="material-icons">photo_camera</span> Letztes Foto</span><strong>{activeTeam?.lastUpload ? formatDateTime(activeTeam.lastUpload.createdAt) : 'noch keines'}</strong></div>
          <div className={`mini-card ${headStartSummary?.expired ? 'warning-card' : ''}`}><span className="card-label"><span className="material-icons">timer</span> Vorsprung</span><strong>{currentState?.status === 'head_start' ? (headStartSummary?.expired ? 'abgelaufen' : headStartSummary?.remainingText ?? '…') : 'bereits vorbei'}</strong></div>
        </div>

        {latestAdminNotice ? (
          <div className="challenge-card admin-notice-card">
            <p className="card-label">
              <span className="material-icons">campaign</span>
              {latestAdminNotice.type === 'admin-pin' ? 'Standortpin' : 'Tipp vom Admin'}
            </p>
            <h3>{String(latestAdminNotice.message)}</h3>
            {latestAdminNotice.type === 'admin-pin' ? (() => {
              const pin = latestAdminNotice.details?.location as { lat?: number; lng?: number } | undefined;
              return pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng) ? (
                <p className="muted">
                  Ziel: {Number(pin.lat).toFixed(5)}, {Number(pin.lng).toFixed(5)}
                </p>
              ) : null;
            })() : null}
          </div>
        ) : null}

        {currentState?.currentCheckpoint?.preview ? (
          <div className="challenge-card">
            <div className="section-head">
              <div>
                <p className="card-label"><span className="material-icons">image</span> Aktuelles Bild</p>
                <h3>{checkpointLabel}</h3>
              </div>
              <span className="status-chip">{isActiveTeamTurn ? 'Ihr seid dran' : 'Gegner muss lösen'}</span>
            </div>
            <img className="photo-preview challenge-preview" src={currentState.currentCheckpoint.preview} alt={currentState.currentCheckpoint.caption || 'Aktuelles Spielbild'} />
            <p className="muted">{isActiveTeamTurn ? 'Findet den Ort und sendet danach ein Bild zurück.' : 'Das andere Team rätselt gerade über dieses Bild.'}</p>
          </div>
        ) : null}

        {currentState?.status === 'review' && isReviewTeam && pendingReview?.checkpoint.preview ? (
          <div className="challenge-card review-card">
            <div className="section-head">
              <div>
                <p className="card-label"><span className="material-icons">rule</span> Rücksendung prüfen</p>
                <h3>{TEAM_META[pendingReview.uploadTeamId].name} hat geantwortet</h3>
              </div>
              <span className="status-chip" style={{ borderColor: TEAM_META[teamId].accent, color: TEAM_META[teamId].accent }}>Review</span>
            </div>
            <img className="photo-preview challenge-preview" src={pendingReview.checkpoint.preview} alt="Antwortbild zur Prüfung" />
            <p className="muted">Wenn der Ort stimmt, das Bild annehmen. Sonst ablehnen und nochmal probieren lassen.</p>
            <div className="button-row">
              <button className="primary" onClick={() => sendReviewDecision('accept')}><span className="material-icons">check_circle</span>Annehmen</button>
              <button className="danger" onClick={() => sendReviewDecision('reject')}><span className="material-icons">cancel</span>Ablehnen</button>
            </div>
          </div>
        ) : null}

        {currentState?.status === 'review' && !isReviewTeam && pendingReview ? (
          <div className="challenge-card review-card muted-card">
            <p className="card-label"><span className="material-icons">hourglass_top</span> Warten auf Prüfung</p>
            <h3>{TEAM_META[pendingReview.reviewTeamId].name} prüft gerade das Rückbild</h3>
            <p className="muted">Sobald angenommen oder abgelehnt wurde, startet die nächste Runde sofort.</p>
          </div>
        ) : null}

        {currentState?.status === 'head_start' && (
          <div className={`card ${headStartSummary?.expired ? 'alert-card' : ''}`}>
            <h3>{headStartSummary?.expired ? (teamId === currentState.leadingTeamId ? 'Jetzt ist Aktion nötig' : 'Der Vorsprung ist abgelaufen') : 'Vorsprung aktiv'}</h3>
            <div className="countdown" style={{ fontSize: '2.5rem', margin: '1rem 0' }}>{headStartSummary?.remainingText ?? '…'}</div>
            <p>
              {headStartSummary?.expired
                ? (teamId === currentState.leadingTeamId ? 'Jetzt muss das erste Foto aufgenommen und hochgeladen werden.' : 'Warte, bis das Startteam sein erstes Foto hochlädt.')
                : (teamId === currentState.leadingTeamId ? 'Du bist das Startteam. Halte das erste Foto bereit.' : 'Das Startteam hat noch Vorsprung.')}
            </p>
          </div>
        )}

        {canUploadPhoto && (
          <div className="upload-panel">
            <label className="button primary">
              <span className="material-icons">photo_camera</span>
              Foto aufnehmen oder auswählen
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
                {isBusy ? 'Wird hochgeladen…' : 'Foto senden'}
              </button>
              <button className="secondary" onClick={requestLocationAccess}>
                <span className="material-icons">my_location</span>
                Standort freigeben
              </button>
            </div>
            <p className="muted">{currentState?.status === 'head_start' ? 'Das Foto startet die nächste Runde.' : 'Ein Foto reicht zur Bestätigung.'}</p>
          </div>
        )}

        {currentState?.status === 'live' && !isActiveTeamTurn && !pendingReview ? (
          <div className="challenge-card muted-card">
            <p className="card-label"><span className="material-icons">visibility</span> Beobachten</p>
            <h3>Warte auf die nächste Rückmeldung</h3>
            <p className="muted">Ihr seht hier das Bild des anderen Teams, bis eure Runde wieder startet.</p>
          </div>
        ) : null}
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
              <div className="mini-card"><span className="card-label"><span className="material-icons">flag</span> Startteam</span><strong>{TEAM_META[currentState?.leadingTeamId ?? 'red'].name}</strong></div>
              <div className="mini-card"><span className="card-label"><span className="material-icons">swap_horiz</span> Aktives Team</span><strong>{TEAM_META[currentState?.activeTeamId ?? 'red'].name}</strong></div>
              <div className={`mini-card ${headStartSummary?.expired ? 'warning-card' : ''}`}><span className="card-label"><span className="material-icons">timer</span> Vorsprung</span><strong>{currentState?.status === 'head_start' ? (headStartSummary?.expired ? 'abgelaufen' : headStartSummary?.remainingText ?? '…') : `${currentState?.headStartMinutes ?? 5} Minuten`}</strong></div>
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
              <label>Hinweis für Team
                <select value={adminTipTeam} onChange={(event) => setAdminTipTeam(event.target.value === 'all' ? 'all' : (event.target.value as TeamId))}>
                  <option value="all">Alle Teams</option>
                  <option value="red">Team Rot</option>
                  <option value="blue">Team Blau</option>
                </select>
              </label>
              <label>Tipptext<input value={adminTipText} onChange={(event) => setAdminTipText(event.target.value)} placeholder="z. B. Sucht beim roten Tor" /></label>
              <label>Pin-Bezeichnung<input value={adminPinLabel} onChange={(event) => setAdminPinLabel(event.target.value)} placeholder="Standortpin" /></label>
              <label>Pin Breite<input value={adminPinLat} onChange={(event) => setAdminPinLat(event.target.value)} /></label>
              <label>Pin Länge<input value={adminPinLng} onChange={(event) => setAdminPinLng(event.target.value)} /></label>
            </div>

            <div className="button-row">
              <button className="primary" onClick={applyAdminConfig}>Konfiguration speichern</button>
              <button className="primary" onClick={startGame}><span className="material-icons">play_arrow</span>Spiel starten</button>
              <button className="primary" onClick={() => createCode('red')}>Code Rot</button>
              <button className="primary" onClick={() => createCode('blue')}>Code Blau</button>
              <button className="secondary" onClick={sendAdminTip}><span className="material-icons">campaign</span>Tipp senden</button>
              <button className="secondary" onClick={sendAdminPin}><span className="material-icons">place</span>Pin senden</button>
            </div>

            <div className="status-card-grid">
              <div className="mini-card"><span className="card-label">Rot-Code</span><strong>{adminCodes.red || 'noch keiner'}</strong></div>
              <div className="mini-card"><span className="card-label">Blau-Code</span><strong>{adminCodes.blue || 'noch keiner'}</strong></div>
            </div>

            {currentState?.joinCodes?.length ? (
              <div className="status-card-grid">
                {currentState.joinCodes.map((entry) => (
                  <button
                    key={entry.code}
                    type="button"
                    className="mini-card selectable-card"
                    onClick={() => {
                      setGameCode(entry.code);
                      setMessage(`Code ${entry.code} in das Join-Feld übernommen.`);
                    }}
                  >
                    <span className="card-label">Laufender Code</span>
                    <strong>{entry.code}</strong>
                    <span className="muted">{TEAM_META[entry.teamId].name}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="qr-grid">
              <QrCodeView code={adminCodes.red || ''} teamId="red" />
              <QrCodeView code={adminCodes.blue || ''} teamId="blue" />
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
              <div className="section-head">
                <div>
                  <p className="card-label"><span className="material-icons">map</span> Admin-Karte</p>
                  <h3>OpenStreetMap Live View</h3>
                </div>
                <span className="status-chip">{currentState?.pendingReview ? 'Review aktiv' : 'Live'}</span>
              </div>
              <OpenStreetMapView state={currentState} />
              <p className="muted">Die Karte zeigt aktuelle Teampositionen, das Zielbild und einen offenen Prüfstatus, falls ein Rückbild noch bestätigt werden muss.</p>
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
        <section className="panel intro-panel" style={{ display: 'grid', gap: 8, maxWidth: 420, margin: '32px auto' }}>
          <div className="section-head">
            <div>
              <p className="card-label"><span className="material-icons">qr_code_2</span> Join</p>
              <h2>Code oder QR</h2>
            </div>
          </div>
          <label style={{ display: 'contents' }}>
            <input value={gameCode} onChange={(e) => setGameCode(e.target.value)} placeholder="Spielcode" autoFocus />
          </label>
          <div className="pill">{introHint}</div>
          <div className="button-row">
            <button className="secondary" onClick={requestLocationAccess}><span className="material-icons">my_location</span> Standort freigeben</button>
            <button className="primary" onClick={joinAsPlayer}><span className="material-icons">login</span> Beitreten</button>
          </div>
        </section>
      ) : null}

      {message ? <div className="banner">{message}</div> : null}
      {requestStatus ? (
        <div className={`request-banner ${requestStatus.phase}`}>
          <strong>{requestStatus.label}</strong>
          <span>{requestStatus.detail || (requestStatus.phase === 'sending' ? 'Anfrage läuft…' : requestStatus.phase === 'waiting' ? 'Antwort steht noch aus…' : 'Offline')}</span>
        </div>
      ) : null}
      {content}

      <footer className="footer">
        <span>{isOnline && connected ? 'Socket verbunden' : isOnline ? 'Socket getrennt' : 'Gerät offline'}</span>
      </footer>
    </main>
  );
}