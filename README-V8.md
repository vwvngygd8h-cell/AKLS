# AKLS V8

Version 8 des AKLS Kennzeichen-Wächters für GitHub Pages.

## Neu in V8
- Gelbe Box direkt um eine erkannte kennzeichentypische Region.
- Grüne Box direkt um ein erfolgreich gelesenes Kennzeichen.
- Rote Box und Alarm nur bei Übereinstimmung mit einem Zielkennzeichen.
- Standardziel: NB-BC 721.
- Update-Fehler aus V7 entfernt: kein dauerhafter „Neue Version verfügbar“-Banner mehr.
- Service Worker aktualisiert automatisch und lädt eine neue Version beim nächsten sicheren Neustart.
- Neues AKLS-App-Icon für iPhone/PWA.
- Wake Lock, Trefferprotokoll, toleranter Zielabgleich und mehrere Zielkennzeichen.

## Installation im bestehenden GitHub-Repository
Alle Dateien aus diesem Ordner in das Root-Verzeichnis des bestehenden AKLS-Repositories hochladen
und gleichnamige Dateien ersetzen:

- index.html
- app.js
- styles.css
- sw.js
- manifest.webmanifest
- icon-512.png
- apple-touch-icon.png

Danach GitHub Pages kurz aktualisieren lassen. Auf dem iPhone die AKLS-Webapp einmal vollständig schließen
und erneut öffnen.

## Hinweis
Die gelbe Kandidatenbox entsteht durch eine schnelle lokale Bildanalyse auf kennzeichentypische,
helle und kantenreiche Rechtecke. Die OCR bestätigt anschließend die Lesung (grün). Nur der Abgleich
mit einem Zielkennzeichen führt zu rot + Alarm.
