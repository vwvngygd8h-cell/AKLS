# AKLS V9.4.3

Hotfix für V9.4.2.

## Behoben
- KI-Schwellenregler war in V9.4.2 zwar im JavaScript vorgesehen, aber nicht im sichtbaren HTML.
- Der YOLO-Arbeitscanvas stand noch auf 192×108.
- Das eingesetzte Kennzeichenmodell erwartet 640×640.
- detectorCanvas ist jetzt korrekt 640×640.
- KI-Schwelle ist in `Feineinstellungen` sichtbar und einstellbar (35–85 %).
- `KI max` bleibt im Live-Telemetrieblock sichtbar.
- Standardwert weiterhin 55 %.
- Zoom, Fokus, OCR, Grün/Rot-Logik und iOS-Kamera-Fix unverändert.

## Test
1. Feineinstellungen öffnen und prüfen, ob `KI-Schwelle` sichtbar ist.
2. Scan starten.
3. Bei einem echten Kennzeichen den Wert `KI max` beobachten.
4. Zunächst bei 55 % testen.
