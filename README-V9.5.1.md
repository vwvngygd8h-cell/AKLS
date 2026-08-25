# AKLS V9.5.1

Korrektur für Fehlboxen im Fahrzeuginnenraum.

## Änderungen
- Standard-KI-Schwelle wieder auf 58 % angehoben.
- Sofortige Ein-Frame-Gelbfreigabe erst ab 82 %.
- Schneller YOLO-Takt aus V9.5 bleibt erhalten.
- Zweite lokale Plausibilitätsprüfung für mittlere YOLO-Treffer:
  - Helligkeitsverteilung
  - dunkle Zeichenanteile
  - helle Hintergrundanteile
  - Kantenstärke
  - vertikale Zeichenstruktur
- Ein Treffer unter 82 % wird nur gelb, wenn diese Kennzeichen-Texturprüfung plausibel ist.
- Gelbe Box zeigt nun ihre YOLO-Konfidenz, z. B. `Kennzeichen 76 %`.
- OCR-/Grün-/Rot-Logik aus V9.5 bleibt erhalten.
- Zoom, Fokus und KI-max-Diagnose bleiben erhalten.

Damit lassen sich echte und falsche Kandidaten beim nächsten Test direkt anhand ihrer Prozentwerte vergleichen.
