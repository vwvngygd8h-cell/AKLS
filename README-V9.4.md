# AKLS V9.4

V9.4 ersetzt die experimentellen gelben Boxen vollständig.

## Pipeline
1. Ein echtes YOLO11-ONNX-Modell erkennt die Position von Autokennzeichen.
2. Diese Position wird sofort gelb eingerahmt.
3. Nur der erkannte Kennzeichenausschnitt wird an Tesseract übergeben.
4. Wiederholt plausible OCR-Lesung = grün.
5. Wiederholt bestätigtes Zielkennzeichen = rot + Alarm.

## Modell
- Quelle: MikeLud/Blue-Iris-Custom-AI-Models
- Modell: `Custom-YOLOv8-11/plates.onnx`
- Klasse: `license_plate`
- Architektur: YOLO11n
- Eingabe: 640 × 640
- Lizenz des Modell-Repositories: MIT

Das ONNX-Modell wird beim Start direkt aus dem öffentlichen GitHub-Repository geladen.
Es wird kein Kamerabild an einen Erkennungsserver gesendet. Die Inferenz läuft mit ONNX Runtime Web
lokal im Browser. Tesseract bleibt ebenfalls lokal.

Zoom, Autofokus, optionaler manueller Fokus und iOS-Kamera-Fix bleiben erhalten.
