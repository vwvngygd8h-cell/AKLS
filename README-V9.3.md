# AKLS V9.3

## Korrekturen gegenüber V9.2
- Der grobe Rechteckdetektor wurde entfernt.
- Gelbe Boxen stammen jetzt aus den tatsächlichen OCR-Wort-/Zeilenkoordinaten.
- Dadurch deutlich kleinere und präzisere Boxen direkt am gelesenen Kennzeichen.
- Gelb = erste plausible Kennzeichenlesung.
- Grün = dieselbe Kennzeichenlesung mehrfach bestätigt.
- Rot + Alarm = Zielkennzeichen mehrfach bestätigt.
- Zoom-Steuerung wieder eingebaut.
- Kontinuierlicher Autofokus wieder eingebaut, sofern Safari/Kamera ihn meldet.
- Manueller Fokus wieder eingebaut, sofern die Kamera `focusDistance` unterstützt.
- iOS-Kamera-Fix aus V9.1 bleibt erhalten.

Technischer Hinweis:
Weil die gelbe Box jetzt an Tesseracts tatsächlicher Textposition hängt, kann sie minimal später erscheinen
als die alten Heuristik-Boxen. Dafür sollte sie wesentlich seltener falsch und deutlich enger am Kennzeichen sitzen.
