// client.js
const socket = io();
let mySocketId = null;
let currentRoom = null;
let side = 0;
let deck = [];
let username = null;

const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const signinBtn = document.getElementById('signin');
const signupBtn = document.getElementById('signup');
const userInfo = document.getElementById('userInfo');
const statsEl = document.getElementById('stats');

signinBtn.onclick = async () => {
  const u = usernameInput.value.trim();
  const p = passwordInput.value;
  if(!u||!p) return alert('enter creds');
  const res = await fetch('/api/signin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  const j = await res.json();
  if(j.ok){ username = u; userInfo.innerText = 'Signed in: '+u; statsEl.innerText = `Wins:${j.user.wins} Losses:${j.user.losses} Crowns:${j.user.crowns}`; } else alert('signin failed: '+(j.error||''));
};

signupBtn.onclick = async () => {
  const u = usernameInput.value.trim();
  const p = passwordInput.value;
  if(!u||!p) return alert('enter creds');
  const res = await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  const j = await res.json();
  if(j.ok) alert('signup ok, now sign in'); else alert('signup failed: '+(j.error||''));
};

// tabs
document.querySelectorAll('.tabBtn').forEach(b=>{
  b.onclick = ()=> {
    document.querySelectorAll('.tab').forEach(t=>t.style.display='none');
    document.getElementById(b.dataset.tab).style.display='block';
  };
});

// lobby chat
const lobbyChat = document.getElementById('lobbyChat');
document.getElementById('sendLobby').onclick = ()=>{
  const text = document.getElementById('lobbyMsg').value.trim();
  if(!text) return;
  if(!username) return alert('sign in first');
  socket.emit('lobbyChat', { text, username });
  document.getElementById('lobbyMsg').value = '';
};
socket.on('lobbyChat', m=>{
  const d = document.createElement('div'); d.innerText = `[${new Date(m.t).toLocaleTimeString()}] ${m.username}: ${m.text}`; lobbyChat.prepend(d);
});

// queue
document.getElementById('joinQueue').onclick = ()=>{
  if(!username) return alert('sign in first');
  socket.emit('joinQueue', { username });
  document.getElementById('queueStatus').innerText = 'Queued...';
};
socket.on('queueStatus', s=>{
  document.getElementById('queueStatus').innerText = `Queued. Position approx ${s.len||'?'}`;
});
socket.on('matchFound', ({ roomId, side: s, deck: d })=>{
  currentRoom = roomId; side = s; deck = d;
  document.getElementById('queueStatus').innerText = 'Matched! Room: '+roomId;
  // switch to game tab
  document.querySelectorAll('.tab').forEach(t=>t.style.display='none');
  document.getElementById('game').style.display='block';
  setupGame();
});

// game UI and networking
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const handEl = document.getElementById('hand');
const elixirEl = document.getElementById('elixir');
const roomChat = document.getElementById('roomChat');

function setupGame(){
  document.getElementById('playerInfoBar').innerText = `Room: ${currentRoom} | You: ${username} | Side: ${side}`;
  renderHand();
}

function renderHand(){
  handEl.innerHTML = '';
  deck.forEach(c=>{
    const b = document.createElement('button');
    b.className='card';
    b.innerText = `${c.name} (${c.cost})`;
    b.onclick = ()=> playCard(c.name);
    handEl.appendChild(b);
  });
}

function playCard(name){
  if(!currentRoom) return;
  const lane = confirm('Top lane? OK=top, Cancel=bottom') ? 0 : 1;
  socket.emit('playCard', { roomId: currentRoom, cardName: name, lane });
}

socket.on('state', snap=>{
  if(!snap) return;
  // find my socket id via local socket
  mySocketId = socket.id;
  if(snap.players && snap.players[mySocketId]) elixirEl.innerText = Math.floor(snap.players[mySocketId].elixir);
  draw(snap);
});

socket.on('roomChat', m=>{
  const d = document.createElement('div'); d.innerText = `[${new Date(m.t).toLocaleTimeString()}] ${m.username}: ${m.text}`; roomChat.prepend(d);
});

document.getElementById('sendRoom').onclick = ()=>{
  const t = document.getElementById('roomMsg').value.trim();
  if(!t) return;
  socket.emit('roomChat', { roomId: currentRoom, text: t, username });
  document.getElementById('roomMsg').value = '';
};

socket.on('gameOver', ({ winnerSide })=>{
  alert('Game over! winner side: ' + winnerSide);
  // update displayed stats by re-signin call
  if(username){
    fetch('/api/signin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username, password: document.getElementById('password').value})})
    .then(r=>r.json()).then(j=>{ if(j.ok) statsEl.innerText = `Wins:${j.user.wins} Losses:${j.user.losses} Crowns:${j.user.crowns}`; });
  }
});

function draw(snap){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = '#71c57d';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  ctx.fillRect(0,160-40,canvas.width,80);
  if(!snap || !snap.entities) return;
  for(let e of snap.entities){
    if(e.type === 'tower'){
      ctx.fillStyle = e.side===0 ? '#0ea5a4' : '#ef4444';
      ctx.fillRect(e.x-20,e.y-20,40,40);
      ctx.fillStyle = '#fff';
      ctx.fillText('HP:'+Math.max(0,Math.round(e.hp)), e.x-16, e.y+36);
    } else if(e.type === 'troop'){
      ctx.beginPath();
      ctx.fillStyle = (e.owner===socket.id) ? '#0ea5a4' : '#ef4444';
      ctx.arc(e.x,e.y,e.radius,0,Math.PI*2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(Math.max(0,Math.round(e.hp)), e.x-10, e.y-18);
    }
  }
}
