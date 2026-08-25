# AKLS V9.3.2

Hotfix für fehlende gelbe Boxen in V9.3.1.

## Geändert
- Gelbe Ersterkennung deutlich empfindlicher.
- OCR-Mindestvertrauen für Gelb reduziert.
- Plausibilitätsprüfung für erste Kandidaten gelockert.
- Kürzere Teilkennzeichen ab 3 Zeichen dürfen als Kandidat dienen.
- Tesseract-Wörter derselben Zeile werden kombiniert:
  z. B. `NB` + `BC` + `721` → `NBBC721`.
- Zulässiges Box-Seitenverhältnis erweitert.
- Bis zu 4 enge OCR-basierte Kandidaten gleichzeitig.
- Grün und Rot bleiben unverändert streng: mindestens 2 Bestätigungen.
- Zoom, Fokus und iOS-Kamera-Fix bleiben erhalten.
