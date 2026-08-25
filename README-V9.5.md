# AKLS V9.5

Optimiert anhand des Tests:
- stehendes Fahrzeug: YOLO KI max ~85 %, gelbe Box funktioniert
- fahrende Fahrzeuge: zu spät/gar nicht
- gelbe Box wird nicht grün

## Änderungen
### Bewegte Fahrzeuge
- künstliche 280-ms-Pause zwischen YOLO-Läufen entfernt (jetzt nur 20 ms Leerlauf)
- Standard-KI-Schwelle 45 %
- ein einzelner sehr sicherer Treffer >=72 % wird sofort gelb
- schwächere Treffer brauchen weiterhin 2 Bestätigungen
- Tracks bleiben 1,15 s erhalten, um kurze Bewegungsunschärfe zu überbrücken

### OCR / Grün
- Kennzeichenausschnitt stärker hochskaliert
- erste OCR-Variante: Graustufen + hoher Kontrast
- zweite OCR-Variante bei Unsicherheit: Binärbild
- niedrigere OCR-Einstiegsschwelle
- Multi-Frame-Konsens über bis zu 8 Lesungen
- zusätzlich zeichenweiser Mehrheitsentscheid bei gleich langen Lesungen
- Grün weiterhin erst nach 2 konsistenten Lesungen
- Rot weiterhin erst nach mehrfach bestätigtem Zielkennzeichen

Zoom, Fokus, KI-max-Diagnose und einstellbare KI-Schwelle bleiben erhalten.
