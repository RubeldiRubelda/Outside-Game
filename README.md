# Outside Game

Echtzeit-Webapp für ein zweigeteiltes Gelände-Spiel mit GPS-Tracking, Foto-Uploads und Admin-Überwachung gegen Schummeln. Die Anwendung läuft auf Port `777` und ist für Docker vorbereitet.

## Funktionen

- Zwei Teams mit Live-Status
- 5-Minuten-Vorsprung für das führende Team
- Foto-Upload als Standort-Beweis
- Echtzeit-GPS für Spieler und Admins
- Warnungen bei auffälligen Standort-Sprüngen oder alten Positionsdaten
- In-memory Spielzustand ohne Datenbank

## Lokal starten

```bash
npm install
npm run dev
```

Dann im Browser `http://localhost:777` öffnen.

## Docker

```bash
docker build -t outside-game .
docker run --rm -p 777:777 outside-game
```

## Konfiguration

- `PORT` steuert den Server-Port, Standard ist `777`
- `ADMIN_TOKEN` schützt die Admin-Aktionen, Standard ist `trail-777`

## Bedienung

1. Im Startbildschirm Team und Namen wählen.
2. Im Admin-Dashboard Vorsprung, Teamnamen und Startteam setzen.
3. Spiel starten und währenddessen GPS/Foto-Daten beobachten.

## Hinweise

- Fotos und Spielstatus werden im Arbeitsspeicher gehalten und gehen beim Neustart verloren.
- Für echtes Outdoor-Tracking sollten die Spieler das Projekt auf einem Smartphone mit Standortfreigabe öffnen.
- Für einen produktiven Einsatz wäre eine echte Authentifizierung und Persistenz sinnvoll.