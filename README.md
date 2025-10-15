# Bilder‑Rätsel Quiz (Prototype)

- Admin: `/admin.html`
- Spieler: `/player.html`

## Start (lokal)

```bash
npm install
npm start
# Öffne http://localhost:3000
```

## Idee / Flow

1. Alle Spieler sehen 15s das Bild + Countdown.
2. Danach wird es **für Spieler** dunkel (Admin sieht es weiterhin).
3. Jeder Spieler klickt den vermuteten Bereich; **nur Team‑Partner** sehen sich gegenseitig live.
4. Team klickt auf **Fertig** → Team‑Lock (kann per **Änderung** wieder gelöst werden).
5. Admin kann:
   - **👀 Klicks zeigen** (Team‑Weise),
   - **🎯 Zielbereich aufdecken** (Maskenloch um Target),
   - **🖼️ Bild komplett zeigen**,
   - Punkte pro Team: **+1 / −1 / ±N**.
6. Richtig trifft: +5 Punkte (manuell vergeben im Admin via +5 oder Setzen).

> In `admin.html` setzt du Ziel (per Klick) & Radius. Das Target wird als Kreis angezeigt.
