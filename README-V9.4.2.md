# AKLS V9.4.2

## Ziel
V9.4.1 war zu streng und zeigte keine Boxen. V9.4.2 macht die YOLO-Erkennung wieder sichtbar,
ohne auf die alten groben Rechteckdetektoren zurückzugehen.

## Änderungen
- Standard-KI-Schwelle: 0,55 statt 0,80.
- Gelbe Box nach 2 bestätigten YOLO-Treffern statt 3.
- Geometriefilter moderat gelockert.
- Track-TTL auf 950 ms.
- Neue Live-Anzeige `KI max`: höchste YOLO-Konfidenz im aktuellen Detektorlauf.
- Neue einstellbare `KI-Erkennungsschwelle` in den Einstellungen (0,35 bis 0,85).
- Einstellung wird im Browser gespeichert.
- Grün und Rot bleiben weiterhin mehrfach bestätigt.
- Zoom, Fokus und iOS-Kamera-Fix bleiben erhalten.

## Testempfehlung
Zunächst mit 55 % testen.
- Wenn `KI max` bei einem echten Kennzeichen z.B. 65–75 % zeigt, aber keine Box kommt: Schwelle etwas senken.
- Wenn falsche Boxen erscheinen: Schwelle erhöhen.
