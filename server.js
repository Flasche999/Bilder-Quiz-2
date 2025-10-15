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

// Upload endpoint: expects {files:[{name, dataUrl}]}
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


// ---- Game State ----
const state = {
  teams: {},        // teamId -> { id, name, points, colorIdx }
  players: {},      // socket.id -> { id, name, teamId, teamName }
  round: null,
  turnTeamId: null, // <— aktuell spielendes Team
  history: [] // array of past rounds {ts, question, imageUrl, winners:[teamIds], clicks, target, radius}
              // { imageUrl, duration, endAt, radius, target:{x,y}, phase: 'idle|countdown|dark|reveal', locks: {teamId:bool}, clicks:{teamId:{[playerId]:{x,y}}} }
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
  // Erstes Team wird automatisch "dran"
  if(!state.turnTeamId) state.turnTeamId = id;
  return state.teams[id];
}

function broadcastState(){
  io.emit('state', {
    teams: state.teams,
    players: state.players,
    turnTeamId: state.turnTeamId
  });
}

// ---- Turn-Helpers ----
function sortedTeamIds(){
  return Object.values(state.teams)
    .sort((a,b)=> a.name.localeCompare(b.name)) // deterministisch
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

// ---- helper: determine winners (teams with any click within radius)
function computeWinners(){
  if(!state.round) return [];
  const winners = [];
  const {clicks, target, radius} = state.round;
  Object.entries(clicks||{}).forEach(([teamId, players])=>{
    const hit = Object.values(players||{}).some(({x,y})=>{
      const dx = (x - target.x), dy = (y - target.y);
      return Math.hypot(dx,dy) <= radius;
    });
    if(hit) winners.push(teamId);
  });
  return winners;
}


// ---- Sockets ----
io.on('connection', (socket)=>{

  // Admin hello
  socket.on('admin:hello', ()=>{
    socket.emit('state', { teams: state.teams, players: state.players, turnTeamId: state.turnTeamId });
    socket.emit('turn:update', {teamId: state.turnTeamId});
    socket.emit('admin:history', state.history);
  });

  // Player joins with name + team
  socket.on('player:join', ({name, teamName})=>{
    if(!name || !teamName) return;
    let team = getOrCreateTeamByName(teamName.trim());
    if(!team){
      socket.emit('toast', 'Es sind bereits 4 Teams aktiv – wähle ein bestehendes Team.');
      return;
    }

    // Enforce max 2 players per team
    const currentPlayers = Object.values(state.players).filter(pp => pp.teamId === team.id).length;
    if(currentPlayers >= 2){
      socket.emit('toast', `Team "${team.name}" ist voll (max. 2 Spieler). Bitte anderes Team wählen oder neues Team anlegen.`);
      return;
    }

    state.players[socket.id] = { id: socket.id, name: name.trim(), teamId: team.id, teamName: team.name };
    socket.join(team.id); // room per team for private updates
    socket.emit('player:accepted', state.players[socket.id]);
    broadcastState();
  });

  // Live click updates (teammates only) + admin overlay
  socket.on('player:clickUpdate', ({x,y})=>{
    const p = state.players[socket.id];
    if(!p || !state.round) return;

    // <<< Nur das aktuell "dran" Team darf klicken >>>
    if(state.turnTeamId && p.teamId !== state.turnTeamId){
      socket.emit('toast', 'Euer Team ist nicht dran.');
      return;
    }

    state.round.clicks[p.teamId] = state.round.clicks[p.teamId] || {};
    state.round.clicks[p.teamId][p.id] = {x,y};
    // Send only to team room
    socket.to(p.teamId).emit('team:mateClick', {x,y});
    // Admin overlay sees all clicks
    io.emit('admin:liveClick', {teamId:p.teamId, playerId:p.id, x, y});
  });

  socket.on('player:lock', ()=>{
    const p = state.players[socket.id];
    if(!p || !state.round) return;

    // <<< Nur das aktuell "dran" Team darf locken >>>
    if(state.turnTeamId && p.teamId !== state.turnTeamId){
      socket.emit('toast', 'Euer Team ist nicht dran.');
      return;
    }

    state.round.locks[p.teamId] = true; // if any player of team confirms, the team is locked
  });

  socket.on('player:unlock', ()=>{
    const p = state.players[socket.id];
    if(!p || !state.round) return;

    // <<< Nur das aktuell "dran" Team darf entsperren >>>
    if(state.turnTeamId && p.teamId !== state.turnTeamId){
      socket.emit('toast', 'Euer Team ist nicht dran.');
      return;
    }

    state.round.locks[p.teamId] = false;
  });

  // ---- Turn control (Admin) ----
  socket.on('admin:setTurn', ({teamId})=> setTurn(teamId));
  socket.on('admin:nextTurn', ()=> nextTurn());
  socket.on('admin:prevTurn', ()=> prevTurn());

  // ---- Admin controls ----
  socket.on('admin:startRound', ({imageUrl, duration, radius, target, question})=>{
    state.round = {
      imageUrl: imageUrl || '/images/sample.jpg',
      duration: Math.max(3, parseInt(duration||15,10)),
      radius: Math.max(5, Math.min(200, parseInt(radius||45,10))),
      target: target && target.x ? target : {x:100,y:100},
      question: question || '',
      phase: 'countdown',
      clicks: {},
      locks: {}
    };
    // Send config to all players
    io.emit('round:config', { imageUrl: state.round.imageUrl, duration: state.round.duration, radius: state.round.radius, question: state.round.question });
    // Countdown ticks
    let t = state.round.duration;
    const tickId = setInterval(()=>{
      t -= 1;
      if(!state.round || state.round.phase!=='countdown'){ clearInterval(tickId); return; }
      io.emit('round:tick', t);
      if(t<=0){
        clearInterval(tickId);
        state.round.phase='dark';
        // Players go dark; admin does not
        io.emit('round:dark');
      }
    }, 1000);
    io.emit('round:tick', t);
  });

  socket.on('admin:revealGuesses', ()=>{
    if(!state.round) return;
    state.round.phase='reveal';
    // On player views we keep teammates view the same; admin sees all team clicks
    io.emit('round:revealGuesses', state.round.clicks);
  });

  socket.on('admin:revealArea', ({autoNext, delayMs})=>{
    if(!state.round) return;
    const { target, radius } = state.round;
    io.emit('round:revealArea', { target, radius });
    // compute winners & save to history
    const winners = computeWinners();
    state.history.push({ ts: Date.now(), question: state.round.question, imageUrl: state.round.imageUrl, winners, clicks: state.round.clicks, target: state.round.target, radius: state.round.radius });
    io.emit('admin:history', state.history);
    if(autoNext){
      const ms = Math.max(0, parseInt(delayMs||3000,10));
      setTimeout(()=>{ io.emit('round:showFull'); }, Math.min(ms, 5000));
      setTimeout(()=>{
        io.emit('admin:requestNext'); // admin client moves playlist to next
      }, Math.max(ms, 1500) + 2000);
    }
  });

  socket.on('admin:showFull', ()=>{
    if(!state.round) return;
    io.emit('round:showFull');
  });

  socket.on('admin:adjustPoints', ({teamId, delta})=>{
    const t = state.teams[teamId];
    if(!t) return;
    t.points = (t.points||0) + (parseInt(delta||0,10));
    broadcastState();
  });

  socket.on('disconnect', ()=>{
    // clean player
    if(state.players[socket.id]){
      const teamId = state.players[socket.id].teamId;
      delete state.players[socket.id];
      // keep teams persistent (no auto-delete to preserve scores)
      broadcastState();
    }
  });
});

server.listen(PORT, ()=>{
  console.log('Bilder-Rätsel Quiz läuft auf http://localhost:'+PORT);
});
