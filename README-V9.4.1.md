# AKLS V9.4.1

Hotfix gegen dauerhafte falsche YOLO-Boxen.

## Änderungen
- YOLO-Konfidenz von 0,36 auf 0,80 erhöht.
- Entspricht der Tages-Empfehlung des Modellautors.
- Gelbe Box erst nach 3 aufeinanderfolgenden KI-Erkennungen derselben Position.
- Kandidat verschwindet nach 3 verpassten Detektorläufen.
- Track-TTL auf 850 ms reduziert.
- Maximal 2 sichtbare Kennzeichen gleichzeitig.
- Strenger Geometriefilter:
  - Seitenverhältnis 1,8 bis 7,5
  - keine extrem großen Boxen
  - keine winzigen Rauschboxen
- NMS auf 0,70 gesetzt, entsprechend üblicher Modellkonfiguration.
- OCR läuft nur auf dreifach bestätigten YOLO-Kennzeichen.
- Zoom, Fokus und iOS-Kamera-Fix bleiben unverändert.
