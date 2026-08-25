# AKLS V9

V9 baut auf V8 auf und verbessert die Kennzeichenerkennung vor allem zeitlich und logisch.

## Neu
- Mehrere Kennzeichenkandidaten gleichzeitig im Livebild.
- Temporales Tracking: eine erkannte Box wird über mehrere Frames verfolgt.
- Gelb sofort beim Kennzeichenkandidaten.
- Grün erst nach mindestens 2 übereinstimmenden OCR-Lesungen innerhalb weniger Frames.
- Rot + Alarm erst nach mindestens 2 bestätigten Zieltreffern.
- Multi-Frame-Konsens statt Einzelbildentscheidung.
- Deutsche Kennzeichen-Plausibilitätsprüfung.
- Verwechslungsmatrix für typische OCR-Fehler: 0/O, 1/I/L, 2/Z, 5/S, 6/G, 8/B.
- Zwei Bildvorverarbeitungen: kontrastierte Graustufen + Binärbild bei unsicherer OCR.
- Zielvergleich mit gewichteter Zeichenähnlichkeit statt nur einfacher Levenshtein-Distanz.
- V8-Update-Mechanismus bleibt ohne den fehlerhaften dauerhaften Update-Banner erhalten.

## Dateien ersetzen
Im bestehenden AKLS-GitHub-Repository diese Dateien mit V9 ersetzen:
- index.html
- app.js
- styles.css
- sw.js
- manifest.webmanifest
- icon-512.png
- apple-touch-icon.png

## Technischer Hinweis
V9 verwendet weiterhin keinen externen Cloud-ANPR-Dienst. Der Kandidatendetektor ist eine lokale,
kennzeichenspezifische Bildanalyse im Browser. Die eigentliche Lesung erfolgt lokal mit Tesseract.js.
Das vermeidet den Upload von Kamerabildern, ist aber nicht identisch mit einem spezialisierten
nativen ANPR-Neuronalen-Netz.
