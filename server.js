const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers(){ try { return JSON.parse(fs.readFileSync(USERS_FILE)); } catch(e){ return {}; } }
function saveUsers(u){ fs.writeFileSync(USERS_FILE, JSON.stringify(u,null,2)); }

function hashPass(username, password){
  // simple salted hash for prototype only (not production-grade)
  const salt = 'royale_salt_v1_' + username;
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// basic REST for sign up / sign in (returns simple ok or error)
app.post('/api/signup', (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({ error: 'missing' });
  const users = loadUsers();
  if(users[username]) return res.status(400).json({ error: 'exists' });
  users[username] = { passwordHash: hashPass(username,password), wins:0, losses:0, crowns:0 };
  saveUsers(users);
  return res.json({ ok:true });
});

app.post('/api/signin', (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({ error: 'missing' });
  const users = loadUsers();
  const u = users[username];
  if(!u) return res.status(400).json({ error: 'no_user' });
  if(u.passwordHash !== hashPass(username,password)) return res.status(400).json({ error: 'bad_pass' });
  // return basic user info (no token for prototype) 
  return res.json({ ok:true, user: { username, wins: u.wins, losses: u.losses, crowns: u.crowns } });
});

// simple in-memory structures
let rooms = {}; // roomId -> room state
let queue = []; // waiting sockets with username
let lobbyChat = []; // recent messages

const TICK_MS = 100;
const ELIXIR_PER_TICK = 0.1;
const MAX_ELIXIR = 10;

// card defs
const CARD_POOL = [
  { name:'Squire', cost: 1, hp: 30, dmg: 4, speed: 2.2 },
  { name:'Axeman', cost: 3, hp: 60, dmg: 10, speed: 1.4 },
  { name:'Archer', cost: 2, hp: 25, dmg: 6, speed: 2.6 },
  { name:'Giant', cost: 5, hp: 200, dmg: 18, speed: 0.9 }
];

function createRoom(roomId){
  return {
    id: roomId,
    players: {}, // socketId -> {id, side, elixir, deck, username}
    entities: [],
    nextEntityId: 1,
    started: false,
    chat: []
  };
}

function spawnTower(room, side){
  const id = room.nextEntityId++;
  const tower = { id, type:'tower', side, hp:100, x: side===0?80:720, y:240, radius:28 };
  room.entities.push(tower);
}

function spawnTroop(room, ownerSocketId, cardDef, lane){
  const id = room.nextEntityId++;
  const player = room.players[ownerSocketId];
  const side = player.side;
  let x = side===0 ? 140 : 660;
  let dir = side===0 ? 1 : -1;
  let y = lane===0 ? 160 : 320;
  const troop = { id, type:'troop', owner:ownerSocketId, card:cardDef.name, hp:cardDef.hp, dmg:cardDef.dmg, speed:cardDef.speed, x, y, dir, radius:12 };
  room.entities.push(troop);
  return troop;
}

function initRoomIfNeeded(roomId){
  if(!rooms[roomId]){
    const r = createRoom(roomId);
    rooms[roomId] = r;
    spawnTower(r,0);
    spawnTower(r,1);
  }
  return rooms[roomId];
}

function roomTick(room){
  Object.values(room.players).forEach(p => { p.elixir = Math.min(MAX_ELIXIR, p.elixir + ELIXIR_PER_TICK); });
  for(let e of room.entities){
    if(e.type==='troop') e.x += e.speed * e.dir;
  }
  // collisions
  for(let e of room.entities){
    if(e.type !== 'troop') continue;
    for(let t of room.entities){
      if(t.type === 'tower'){
        const ownerSide = room.players[e.owner].side;
        if(t.side === ownerSide) continue;
        const dist = Math.hypot(t.x - e.x, t.y - e.y);
        if(dist < e.radius + t.radius + 6){
          t.hp -= e.dmg;
        }
      }
    }
    for(let t2 of room.entities){
      if(t2.type !== 'troop' || t2.owner === e.owner) continue;
      const dist = Math.hypot(t2.x - e.x, t2.y - e.y);
      if(dist < e.radius + t2.radius + 2){
        t2.hp -= e.dmg * 0.5;
        e.hp -= t2.dmg * 0.5;
      }
    }
  }
  room.entities = room.entities.filter(e => {
    if((e.type==='troop' || e.type==='tower') && e.hp <= 0) return false;
    return true;
  });
  const towers = room.entities.filter(e => e.type === 'tower');
  if(towers.length < 2){
    let winnerSide = towers[0] ? towers[0].side : null;
    io.to(room.id).emit('gameOver', { winnerSide });
    // update stats
    try {
      const users = loadUsers();
      for(let sid in room.players){
        const p = room.players[sid];
        const username = p.username;
        if(!users[username]) continue;
        if(p.side === winnerSide){
          users[username].wins = (users[username].wins||0) + 1;
          users[username].crowns = (users[username].crowns||0) + 3; // prototype: winner gets 3 crowns
        } else {
          users[username].losses = (users[username].losses||0) + 1;
        }
      }
      saveUsers(users);
    } catch(e){ console.error('save stats err', e); }
    clearInterval(room.interval);
    delete rooms[room.id];
    return;
  }
  const snapshot = {
    players: Object.fromEntries(Object.entries(room.players).map(([sid,p])=>[sid,{elixir:p.elixir,side:p.side,username:p.username}])),
    entities: room.entities,
    t: Date.now()
  };
  io.to(room.id).emit('state', snapshot);
}

io.on('connection', socket=>{
  console.log('conn', socket.id);

  socket.on('lobbyChat', (msg) => {
    const m = { id: socket.id, text: msg.text, username: msg.username, t: Date.now() };
    lobbyChat.unshift(m);
    if(lobbyChat.length>200) lobbyChat.pop();
    io.emit('lobbyChat', m);
  });

  socket.on('joinQueue', ({ username })=>{
    // ensure not in queue
    if(queue.find(q=>q.socketId===socket.id)) return;
    queue.push({ socketId: socket.id, username });
    io.to(socket.id).emit('queueStatus', { queued: true, len: queue.length });
    // if two players, create a room
    if(queue.length >= 2){
      const a = queue.shift();
      const b = queue.shift();
      const roomId = 'room_' + Date.now();
      const room = initRoomIfNeeded(roomId);
      // assign players
      room.players[a.socketId] = { id: a.socketId, side: 0, elixir:5, deck: CARD_POOL.slice(0,4), username: a.username };
      room.players[b.socketId] = { id: b.socketId, side: 1, elixir:5, deck: CARD_POOL.slice(0,4), username: b.username };
      // join sockets to room
      io.sockets.sockets.get(a.socketId)?.join(roomId);
      io.sockets.sockets.get(b.socketId)?.join(roomId);
      // notify players
      io.to(a.socketId).emit('matchFound', { roomId, side:0, deck: room.players[a.socketId].deck });
      io.to(b.socketId).emit('matchFound', { roomId, side:1, deck: room.players[b.socketId].deck });
      // start ticking
      room.started = true;
      room.interval = setInterval(()=>roomTick(room), TICK_MS);
    }
  });

  socket.on('playCard', ({ roomId, cardName, lane })=>{
    const room = rooms[roomId];
    if(!room) return;
    const player = room.players[socket.id];
    if(!player) return;
    const card = player.deck.find(c=>c.name===cardName);
    if(!card) return;
    if(player.elixir < card.cost){
      io.to(socket.id).emit('msg', 'Not enough elixir');
      return;
    }
    player.elixir -= card.cost;
    const troop = spawnTroop(room, socket.id, card, lane);
    io.to(roomId).emit('spawn', { troop });
  });

  socket.on('roomChat', ({ roomId, text, username })=>{
    const room = rooms[roomId];
    if(!room) return;
    const m = { id: socket.id, text, username, t: Date.now() };
    room.chat.unshift(m);
    if(room.chat.length>200) room.chat.pop();
    io.to(roomId).emit('roomChat', m);
  });

  socket.on('disconnect', () => {
    // remove from queue
    queue = queue.filter(q => q.socketId !== socket.id);
    // remove from rooms
    for(let rid of Object.keys(rooms)){
      const r = rooms[rid];
      if(r.players[socket.id]){
        delete r.players[socket.id];
        io.to(rid).emit('meta', { players: Object.keys(r.players).length });
        if(Object.keys(r.players).length === 0){
          clearInterval(r.interval);
          delete rooms[rid];
        }
      }
    }
    console.log('disconn', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log('listening', PORT));
