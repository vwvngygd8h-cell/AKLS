# AKLS V9.6

Optimiert anhand konkreter Messwerte:
- Fußraum: KI max 50 %
- echtes stehendes Kennzeichen in 3 m: KI max 87 %
- echtes Kennzeichen bleibt gelb / OCR bestätigt nicht
- Gegenverkehr wird nicht bzw. sehr spät erkannt

## Kritischer Bugfix
In V9.5.1 verwendeten Kennzeichen-Texturprüfung und OCR denselben Canvas.
Der laufende YOLO-Detektor konnte dadurch den OCR-Bildausschnitt überschreiben.
V9.6 trennt beide Bildpuffer vollständig.

## Erkennung bewegter Fahrzeuge
- Standard-KI-Schwelle 54 % (knapp über gemessenem Fußraumwert 50 %)
- sehr sicher ab 78 % sofort gelb
- ab 58 % sofort gelb, wenn die Kennzeichen-Textur stark plausibel ist
- YOLO-Leerlauf von 20 ms auf 5 ms reduziert
- Kamera fordert 60 fps an, sofern iPhone/Safari dies unterstützt
- Track-TTL 900 ms

## OCR / Grün
- drei gestufte OCR-Pässe
  1. Kontrast + PSM 7
  2. Kontrast + PSM 8 (ein einzelnes Wort/Kennzeichen)
  3. Binärbild + PSM 7 bei weiterhin schwacher Lesung
- starkes Upscaling des Kennzeichenausschnitts
- Multi-Frame-Konsens bleibt erhalten
- neue Live-Anzeige `OCR roh` zeigt erkannte Zeichen + OCR-Konfidenz

## Test
Beim stehenden 87-%-Kennzeichen beobachten:
- `KI max`
- `OCR roh`
- ob Gelb nach spätestens wenigen OCR-Läufen Grün wird

Beim Gegenverkehr beobachten:
- ob kurz eine gelbe Box erscheint
- welchen `KI max`-Spitzenwert AKLS erreicht
