# AKLS – Kennzeichen-Wächter V6

V6 baut auf V5 auf und ergänzt eine echte KI-Fahrzeug-/Fotoassistenz.

## Änderungen gegenüber V5

- COCO-SSD erkennt Fahrzeuge im Kamerabild (`car`, `truck`, `bus`, `motorcycle`).
- MobileNet V2 erzeugt Bild-Embeddings für erkannte Fahrzeuge und Referenzfotos.
- Referenzfotos werden beim Hinzufügen automatisch auf das erkannte Fahrzeug zugeschnitten.
- Bereits in V5 gespeicherte Referenzfotos bleiben erhalten und werden beim ersten KI-Start automatisch migriert.
- Fotoerkennung erzeugt nur **HINWEISE**. Ein **TREFFER** bleibt an die Kennzeichen-OCR gebunden.
- Ein Foto-Hinweis benötigt wiederholte/stabile Übereinstimmung oder zusätzliche OCR-Unterstützung.
- Erkannte Fahrzeuge werden im Livebild eingerahmt; der beste Foto-Match wird gelb markiert.
- Der rote Vollbild-Trefferhintergrund bleibt entfernt.

## Update des GitHub-Pages-Repositories AKLS

Im Repository die folgenden Dateien aus diesem Paket ersetzen:

- `index.html`
- `app.js`
- `styles.css`
- `sw.js`
- `manifest.webmanifest`
- `icon.svg`

GitHub Pages veröffentlicht die neue Version anschließend wie bisher.

## Erster Start

Die OCR und die KI-Modelle werden aus dem Internet geladen. Danach laufen OCR, Fahrzeugerkennung und Fotovergleich im Browser auf dem Gerät. Die eigentlichen Referenzfotos/Embeddings werden lokal im IndexedDB-Speicher der Webapp abgelegt.

## Empfohlene Referenzfotos

Pro Zielkennzeichen möglichst mehrere Ansichten desselben Fahrzeugs hinterlegen, z. B. vorne, schräg vorne und seitlich. Je weniger andere Fahrzeuge und Hintergrund das Referenzfoto dominieren, desto besser.
