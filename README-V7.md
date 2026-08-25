# AKLS V7

- Drei Ansichten: Einstellungen, Scan, Protokoll.
- Scanstart öffnet automatisch den reduzierten Scanmodus.
- Während des Scans verschwinden Kopfzeile und Reiter.
- Sichtbar bleiben Kamera, Zoom, Fokus, Zielstatus und kompakte Live-Werte.
- Stoppen führt zurück zu den Einstellungen.
- PWA-Manifest + Apple-Touch-Icon für den iPhone-Homescreen.
- Auto-Update-Prüfung beim Start, beim Zurückkehren in die App und alle 60 Sekunden.
- Ein laufender Scan wird nie durch ein Update unterbrochen; Neustart erfolgt erst nach Stoppen.
- Network-First für lokale App-Dateien verhindert, dass eine alte PWA-Version dauerhaft im Cache hängen bleibt.
