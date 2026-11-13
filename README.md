# Wandelplanner

Web-app voor de iPhone waarmee je wandelingen door heel Europa plant.

- Tik op de kaart om punten te zetten; de route volgt wandelpaden.
- Afstand, wandeltijd, hoogtemeters en een hoogteprofiel.
- Wandelingen opslaan op je toestel en delen als GPX-bestand.
- Zoeken op plaatsnaam, je eigen locatie tonen, topografische kaart en bewegwijzerde wandelroutes als extra laag.

## Op je iPhone zetten

1. Open de app in Safari.
2. Tik op de deelknop en kies **Zet op beginscherm**.

## Techniek

Statische site zonder bouwstap: `index.html`, `styles.css`, `app.js` en Leaflet in `vendor/`.
Kaarten komen van OpenStreetMap, OpenTopoMap en Waymarked Trails, routes van BRouter
(met OSRM als reserve) en zoekresultaten van Photon. Opgeslagen wandelingen staan alleen
in de browser van het toestel.
