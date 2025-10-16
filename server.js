// server.js – Bilder-Rätsel Quiz (Node + Express + Socket.IO)
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({limit:'25mb'}));

const PORT = process.env.PORT || 3000;

/* ===========================
   Upload endpoint
   expects {files:[{name, dataUrl}]}
=========================== */
app.post('/admin/upload', async (req, res)=>{
  try{
    const files = req.body && req.body.files;
    if(!Array.isArray(files) || !files.length) return res.status(400).json({error:'No files'});
    const saved = [];
    for(const f of files){
      const name = (f.name||'upload').replace(/[^a-z0-9_\-\.]/gi,'_');
      const dataUrl = f.dataUrl||'';
      const m = dataUrl.match(/^data:(.+);base64,(.*)$/);
      if(!m) continue;
      const b64 = m[2];
      const buf = Buffer.from(b64, 'base64');
      const dest = path.join(__dirname, 'public', 'uploads', name);
      await fs.promises.writeFile(dest, buf);
      saved.push('/uploads/'+name);
    }
    res.json({ok:true, urls:saved});
  }catch(e){
    console.error('upload error', e);
    res.status(500).json({error:String(e)});
  }
});

/* ===========================
   Global Game State
=========================== */
const state = {
  teams: {},        // teamId -> { id, name, points, colorIdx }
  players: {},      // socket.id -> { id, name, teamId, teamName }
  round: null,      // siehe unten
  turnTeamId: null, // aktuelles Team, das klicken/bestätigen darf
  history: []       // Vergangene Runden
};

function teamCount(){ return Object.keys(state.teams).length; }

const COLORS = ["#4da3ff","#ff4d6d","#22c55e","#eab308"];
function getOrCreateTeamByName(name){
  const existing = Object.values(state.teams).find(t=> t.name.toLowerCase() === name.toLowerCase());
  if(existing) return existing;
  if(teamCount() >= 4) return null; // limit to 4 teams
  const id = 't'+Math.random().toString(36).slice(2,8);
  const colorIdx = Object.keys(state.teams).length % COLORS.length;
  state.teams[id] = { id, name, points: 0, colorIdx };
  if(!state.turnTeamId) state.turnTeamId = id; // erstes Team ist dran
  return state.teams[id];
}

function broadcastState(){
  io.emit('state', {
    teams: state.teams,
    players: state.players,
    turnTeamId: state.turnTeamId
  });
}

/* ===========================
   Turn Helpers
=========================== */
function sortedTeamIds(){
  return Object.values(state.teams)
    .sort((a,b)=> a.name.localeCompare(b.name))
    .map(t=>t.id);
}
function setTurn(teamId){
  if(!teamId || !state.teams[teamId]) return;
  state.turnTeamId = teamId;
  io.emit('turn:update', {teamId});
  broadcastState();
}
function nextTurn(){
  const ids = sortedTeamIds();
  if(!ids.length) return;
  if(!state.turnTeamId) { setTurn(ids[0]); return; }
  const i = ids.indexOf(state.turnTeamId);
  const n = ids[(i+1) % ids.length];
  setTurn(n);
}
function prevTurn(){
  const ids = sortedTeamIds();
  if(!ids.length) return;
  if(!state.turnTeamId) { setTurn(ids[0]); return; }
  const i = ids.indexOf(state.turnTeamId);
  const p = ids[(i-1+ids.length) % ids.length];
  setTurn(p);
}

/* ===========================
   Winner / Hit Check Helpers
=========================== */
// Trefferprüfung für Pixel-Koordinaten
function isPixelHit(clickXY, targetXY, radiusPx){
  if(!clickXY || !targetXY) return false;
  const dx = clickXY.x - targetXY.x;
  const dy = clickXY.y - targetXY.y;
  return Math.hypot(dx, dy) <= (radiusPx || 0);
}

// Gewinner anhand TEAM-Kreisen (Pixelraum)
function computeWinnersFromTeamCircles(){
  if(!state.round) return [];
  const R = state.round;
  if(R.isNormalized) return []; // bei normierten Daten kein Auto-Hit (fehlender Norm-Radius)
  const winners = [];
  Object.entries(R.teamCircles || {}).forEach(([teamId, c])=>{
    if(c && !c.normalized && isPixelHit(c, R.target, R.radius)) winners.push(teamId);
  });
  return winners;
}

/* ===========================
   Sockets
=========================== */
io.on('connection', (socket)=>{

  // Sofort Zustand schicken
  socket.emit('state', { teams: state.teams, players: state.players, turnTeamId: state.turnTeamId });
  socket.emit('turn:update', { teamId: state.turnTeamId });

  // Spieler/Admin rehello (Reconnect)
  socket.on('player:hello', ()=>{
    socket.emit('state', { teams: state.teams, players: state.players, turnTeamId: state.turnTeamId });
    socket.emit('turn:update', { teamId: state.turnTeamId });
    if(state.round){
      socket.emit('round:config', {
        imageUrl: state.round.imageUrl,
        duration: state.round.duration,
        radius: state.round.radius,
        question: state.round.question,
        target: state.round.target,
        isNormalized: !!state.round.isNormalized
      });
      // aktuelle Phase pushen
      if(state.round.phase==='dark') socket.emit('round:dark');
      if(state.round.revealClicks) socket.emit('round:revealTeamCircles', { reveal:true, teamCircles: state.round.teamCircles });
    }
  });

  socket.on('admin:hello', ()=>{
    socket.emit('state', { teams: state.teams, players: state.players, turnTeamId: state.turnTeamId });
    socket.emit('turn:update', {teamId: state.turnTeamId});
    socket.emit('admin:history', state.history);
    if(state.round){
      socket.emit('round:config', {
        imageUrl: state.round.imageUrl,
        duration: state.round.duration,
        radius: state.round.radius,
        question: state.round.question,
        target: state.round.target,
        isNormalized: !!state.round.isNormalized
      });
    }
  });

  /* ---------- Player Join ---------- */
  socket.on('player:join', ({name, teamName})=>{
    if(!name || !teamName) return;
    let team = getOrCreateTeamByName(teamName.trim());
    if(!team){
      socket.emit('toast', 'Es sind bereits 4 Teams aktiv – wähle ein bestehendes Team.');
      return;
    }

    // MAX 2 Spieler pro Team
    const currentPlayers = Object.values(state.players).filter(pp => pp.teamId === team.id).length;
    if(currentPlayers >= 2){
      socket.emit('toast', `Team "${team.name}" ist voll (max. 2 Spieler). Bitte anderes Team wählen oder neues Team anlegen.`);
      return;
    }

    state.players[socket.id] = { id: socket.id, name: name.trim(), teamId: team.id, teamName: team.name };
    socket.join(team.id); // team room
    socket.emit('player:accepted', state.players[socket.id]);
    broadcastState();
  });

  /* =======================================================
     >>> NEU: TEAM-Klick-Logik (ein Kreis pro Team, gemeinsam)
     Events:
      - team:setCircle  {x,y,normalized?}
      - team:confirm    ()
      - team:unconfirm  ()   (optional)
      - admin:revealTeamCircles / admin:hideTeamCircles
      - admin:clearTeamCircles
      - admin:newRound  ({imageUrl, duration, radius, target, question})
  ======================================================= */

  // Ein Team-Kreis setzen/versetzen (beide Spieler dürfen)
  socket.on('team:setCircle', ({x, y, normalized})=>{
    const p = state.players[socket.id];
    if(!p || !state.round) return;

    // Nur das "dran" Team darf seinen Kreis setzen
    if(state.turnTeamId && p.teamId !== state.turnTeamId){
      socket.emit('toast', 'Euer Team ist nicht dran.');
      return;
    }

    const R = state.round;
    R.teamCircles = R.teamCircles || {};
    R.teamLocked  = R.teamLocked  || {};

    // Wenn Team bereits bestätigt hat, darf es nicht mehr ändern
    if(R.teamLocked[p.teamId]){
      socket.emit('toast', 'Euer Team ist bereits eingeloggt.');
      return;
    }

    R.teamCircles[p.teamId] = { x, y, normalized: !!normalized };

    // Vorschau an Team-Mate (schwach/privat), Admin sieht, dass Kreis gesetzt wurde
    socket.to(p.teamId).emit('team:circlePreview', { x, y, normalized: !!normalized });
    io.emit('admin:teamCircleSet', { teamId: p.teamId });
  });

  // Team bestätigt (einloggen)
  socket.on('team:confirm', ()=>{
    const p = state.players[socket.id];
    if(!p || !state.round) return;

    // Nur das "dran" Team darf bestätigen
    if(state.turnTeamId && p.teamId !== state.turnTeamId){
      socket.emit('toast', 'Euer Team ist nicht dran.');
      return;
    }

    const R = state.round;
    R.teamCircles = R.teamCircles || {};
    R.teamLocked  = R.teamLocked  || {};

    if(!R.teamCircles[p.teamId]){
      socket.emit('toast', 'Bitte zuerst eure Position setzen.');
      return;
    }
    if(R.teamLocked[p.teamId]) return; // schon gelockt

    R.teamLocked[p.teamId] = true;

    // Admin-UI: Team eingeloggt anzeigen
    io.emit('admin:teamLocked', { teamId: p.teamId });

    // Auto +5 Punkte bei Treffer (nur Pixel-Koordinaten)
    if(!R.isNormalized){
      const circle = R.teamCircles[p.teamId];
      if(isPixelHit(circle, R.target, R.radius)){
        const t = state.teams[p.teamId];
        if(t){
          t.points = (t.points||0) + 5;
          broadcastState(); // Punkte an alle
          io.emit('score:autoBonus', { teamId: p.teamId, delta: 5 });
        }
      }
    }
  });

  // Optional: Team kann vor Reveal wieder entsperren
  socket.on('team:unconfirm', ()=>{
    const p = state.players[socket.id];
    if(!p || !state.round) return;
    if(state.turnTeamId && p.teamId !== state.turnTeamId) return;

    const R = state.round;
    if(R.teamLocked && R.teamLocked[p.teamId]){
      R.teamLocked[p.teamId] = false;
      io.emit('admin:teamUnlocked', { teamId: p.teamId });
    }
  });

  /* ---------- Admin: Turn Control ---------- */
  socket.on('admin:setTurn', ({teamId})=> setTurn(teamId));
  socket.on('admin:nextTurn', ()=> nextTurn());
  socket.on('admin:prevTurn', ()=> prevTurn());

  /* ---------- Admin: Runde starten ---------- */
  // target: {x,y, normalized?}; radius: Pixel-Radius (für Pixelziele)
  socket.on('admin:startRound', ({imageUrl, duration, radius, target, question})=>{
    state.round = {
      imageUrl: imageUrl || '/images/sample.jpg',
      duration: Math.max(3, parseInt(duration||15,10)),
      radius: Math.max(5, Math.min(200, parseInt(radius||45,10))), // Pixel
      target: (target && target.x!=null) ? target : {x:100,y:100},
      isNormalized: !!(target && target.normalized), // true = target.x/y sind 0..1 (Server auto-Hit aus)
      question: question || '',
      phase: 'countdown',
      // <<< NEU: Team-Kreise/Locks/Reveal-Flag >>>
      teamCircles: {},           // teamId -> {x,y,normalized?}
      teamLocked: {},            // teamId -> bool
      revealClicks: false
    };

    // Round-Config an alle
    io.emit('round:config', { 
      imageUrl: state.round.imageUrl,
      duration: state.round.duration,
      radius: state.round.radius,
      question: state.round.question,
      target: state.round.target,
      isNormalized: !!state.round.isNormalized
    });

    // Countdown → Dunkelphase (Spieler zeigen Frage erst da)
    let t = state.round.duration;
    const tickId = setInterval(()=>{
      t -= 1;
      if(!state.round || state.round.phase!=='countdown'){ clearInterval(tickId); return; }
      io.emit('round:tick', t);
      if(t<=0){
        clearInterval(tickId);
        if(!state.round) return;
        state.round.phase='dark';
        io.emit('round:dark'); // Spieler zeigen ab jetzt die Frage
      }
    }, 1000);
    io.emit('round:tick', t);
  });

  /* ---------- Admin: Klicks anzeigen/ausblenden ---------- */
  socket.on('admin:revealTeamCircles', ()=>{
    if(!state.round) return;
    state.round.revealClicks = true;
    io.emit('round:revealTeamCircles', { reveal:true, teamCircles: state.round.teamCircles || {} });
  });

  socket.on('admin:hideTeamCircles', ()=>{
    if(!state.round) return;
    state.round.revealClicks = false;
    io.emit('round:revealTeamCircles', { reveal:false });
  });

  /* ---------- Admin: Klicks entfernen ---------- */
  socket.on('admin:clearTeamCircles', ()=>{
    if(!state.round) return;
    state.round.teamCircles = {};
    state.round.teamLocked  = {};
    io.emit('round:clearTeamCircles');
  });

  /* ---------- Admin: Reveal Zielbereich / Gewinner berechnen ---------- */
  socket.on('admin:revealArea', ({autoNext, delayMs})=>{
    if(!state.round) return;
    const { target, radius, isNormalized } = state.round;
    io.emit('round:revealArea', { target, radius, isNormalized: !!isNormalized });

    // Gewinner bestimmen (nur Pixel-Modus)
    const winners = computeWinnersFromTeamCircles();
    state.history.push({
      ts: Date.now(),
      question: state.round.question,
      imageUrl: state.round.imageUrl,
      winners,
      teamCircles: state.round.teamCircles,
      target: state.round.target,
      radius: state.round.radius
    });
    io.emit('admin:history', state.history);

    if(autoNext){
      const ms = Math.max(0, parseInt(delayMs||3000,10));
      setTimeout(()=>{ io.emit('round:showFull'); }, Math.min(ms, 5000));
      setTimeout(()=>{ io.emit('admin:requestNext'); }, Math.max(ms, 1500) + 2000);
    }
  });

  socket.on('admin:showFull', ()=>{
    if(!state.round) return;
    io.emit('round:showFull');
  });

  /* ---------- Admin: Punkte manuell anpassen ---------- */
  socket.on('admin:adjustPoints', ({teamId, delta})=>{
    const t = state.teams[teamId];
    if(!t) return;
    t.points = (t.points||0) + (parseInt(delta||0,10));
    broadcastState();
  });

  /* ---------- Admin: Neue Runde (Reset + optional neue Daten) ---------- */
  socket.on('admin:newRound', ({imageUrl, duration, radius, target, question})=>{
    // vergangene Runde ggf. schließen
    if(state.round){
      state.history.push({
        ts: Date.now(),
        question: state.round.question,
        imageUrl: state.round.imageUrl,
        winners: [],
        teamCircles: state.round.teamCircles,
        target: state.round.target,
        radius: state.round.radius
      });
      io.emit('admin:history', state.history);
    }

    // neue Runde starten (gleiche Logik wie startRound)
    state.round = {
      imageUrl: imageUrl || '/images/sample.jpg',
      duration: Math.max(3, parseInt(duration||15,10)),
      radius: Math.max(5, Math.min(200, parseInt(radius||45,10))),
      target: (target && target.x!=null) ? target : {x:100,y:100},
      isNormalized: !!(target && target.normalized),
      question: question || '',
      phase: 'countdown',
      teamCircles: {},
      teamLocked: {},
      revealClicks: false
    };

    io.emit('round:config', { 
      imageUrl: state.round.imageUrl,
      duration: state.round.duration,
      radius: state.round.radius,
      question: state.round.question,
      target: state.round.target,
      isNormalized: !!state.round.isNormalized
    });

    let t = state.round.duration;
    const tickId = setInterval(()=>{
      t -= 1;
      if(!state.round || state.round.phase!=='countdown'){ clearInterval(tickId); return; }
      io.emit('round:tick', t);
      if(t<=0){
        clearInterval(tickId);
        if(!state.round) return;
        state.round.phase='dark';
        io.emit('round:dark');
      }
    }, 1000);
    io.emit('round:tick', t);
  });

  /* ---------- Disconnect ---------- */
  socket.on('disconnect', ()=>{
    if(state.players[socket.id]){
      delete state.players[socket.id];
      broadcastState();
    }
  });
});

server.listen(PORT, ()=>{
  console.log('Bilder-Rätsel Quiz läuft auf http://localhost:'+PORT);
});
