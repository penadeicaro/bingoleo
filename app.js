import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, updateDoc, collection, getDocs,
  addDoc, onSnapshot, serverTimestamp, query, orderBy, arrayUnion }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

// ===== 1. COLOQUE AQUI SEU firebaseConfig (Firebase Console > Configurações do projeto) =====
const firebaseConfig = {
  apiKey: "AIzaSyCkRCAo16Kiv-AlxXg7jRc48bFT99p1nP0",
  authDomain: "bingoleo.firebaseapp.com",
  projectId: "bingoleo",
  storageBucket: "bingoleo.firebasestorage.app",
  messagingSenderId: "394932742416",
  appId: "1:394932742416:web:9dc6f7d566c2fa35b8dd95"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const messaging = getMessaging(app);
const GAME = doc(db, "game/current");
const provider = new GoogleAuthProvider();

let user = null, isAdmin = false, game = null, phrases = [], players = [];

const $ = id => document.getElementById(id);
const esc = s => s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));

// ---------- Auth ----------
$("authBtn").onclick = () => user ? signOut(auth) : signInWithPopup(auth, provider);
onAuthStateChanged(auth, async u => {
  user = u;
  if (u) {
    const a = await getDoc(doc(db, "admins", u.email));
    isAdmin = a.exists();
    // fcm token
    try { const t = await getToken(messaging, { vapidKey: VAPID_KEY });
      await setDoc(doc(db,"game/current/players",u.uid), { name:u.displayName, photoURL:u.photoURL,
        fcmToken:t }, { merge:true }); } catch(e){}
  }
  $("userInfo").innerHTML = u ? `<img src="${u.photoURL}" width="28" style="border-radius:50%;vertical-align:middle"> ${esc(u.displayName||"")}` : "";
  $("authBtn").textContent = u ? "Sair" : "Entrar com Google";
  $("loginBox").style.display = u ? "none" : "grid";
  $("app").style.display = u ? "block" : "none";
  if (u) start();
});

// ---------- Realtime ----------
function start() {
  onSnapshot(GAME, s => { game = s.data(); renderGame(); });
  onSnapshot(query(collection(db,"game/current/phrases"), orderBy("order")), s => {
    phrases = s.docs.map(d => ({ id:d.id, ...d.data() })); renderBoard(); });
  onSnapshot(collection(db,"game/current/players"), s => {
    players = s.docs.map(d => ({ id:d.id, ...d.data() })); renderBoard(); renderRanking(); });
  onSnapshot(query(collection(db,"game/current/feed"), orderBy("ts","desc")), s => {
    $("feed").innerHTML = s.docs.slice(0,20).map(d => `<li>${esc(d.data().text)}</li>`).join(""); });
}

const active = () => game && game.status === "active"
  && Date.now() >= game.startAt?.toMillis() && Date.now() <= game.endAt?.toMillis();

function renderGame() {
  if (!game) { $("gameStatus").textContent = "Aguardando admin criar o jogo"; return; }
  const st = {draft:"Rascunho", active:"Ativo", finished:"Encerrado"}[game.status];
  const win = game.winnerName ? ` | 🏆 ${esc(game.winnerName)}` : "";
  $("gameStatus").textContent = `${st}${win}`;
  if (isAdmin) renderAdmin();
}

// ---------- Admin ----------
function renderAdmin() {
  const p = $("adminPanel");
  if (game && game.status !== "draft") { p.innerHTML = `
    <div class="card"><h3>Admin</h3><p class="muted">Jogo ${game.status}. Clique em uma foto marcada para anular.</p>
    <button class="ghost" id="resetBtn">Zerar jogo</button></div>`;
    $("resetBtn").onclick = resetGame; return; }
  p.innerHTML = `<div class="card"><h3>Criar jogo (admin)</h3>
    <textarea id="phrasesTxt" rows="8" placeholder="Uma frase por linha"></textarea>
    <div class="row"><input type="datetime-local" id="startIn"><input type="datetime-local" id="endIn"></div>
    <button id="createBtn">Criar e iniciar</button></div>`;
  $("createBtn").onclick = async () => {
    const list = $("phrasesTxt").value.split("\n").map(s=>s.trim()).filter(Boolean);
    const start = new Date($("startIn").value), end = new Date($("endIn").value);
    await setDoc(GAME, { status:"active", startAt:start, endAt:end, createdAt:serverTimestamp(), winnerUid:null, winnerName:null });
    for (let i=0;i<list.length;i++)
      await addDoc(collection(db,"game/current/phrases"), { text:list[i], order:i });
  };
}
async function resetGame() {
  for (const s of await getDocs(collection(db,"game/current/phrases"))) await deleteDoc(s.ref);
  for (const s of await getDocs(collection(db,"game/current/feed"))) await deleteDoc(s.ref);
  await updateDoc(GAME, { status:"draft", winnerUid:null, winnerName:null });
}

// ---------- Board ----------
function renderBoard() {
  if (!phrases.length) { $("board").innerHTML = `<p class="muted">Nenhuma frase ainda.</p>`; return; }
  $("board").innerHTML = phrases.map(ph => {
    const markers = players
      .filter(p => p.marks && p.marks[ph.id])
      .sort((a,b) => a.marks[ph.id].toMillis() - b.marks[ph.id].toMillis());
    const circles = markers.map(p => `<div class="circle" title="${esc(p.name||"")}"><img src="${p.photoURL||""}"></div>`).join("")
      + `<div class="circle empty"></div>`.repeat(Math.max(players.length - markers.length, 0));
    const mine = user && markers.some(p => p.id === user.uid);
    return `<div class="phraseBox ${mine?"mine":""}">
      <p>${esc(ph.text)} ${isAdmin && markers.length ? `<button class="ghost" style="padding:2px 8px;font-size:11px" onclick="window.__unmark('${ph.id}')">anular</button>`:""}</p>
      <div class="avatars" ${active() && user && !mine ? `onclick="window.__mark('${ph.id}')" style="cursor:pointer"` : ""}>${circles}</div>
    </div>`;
  }).join("");
}

// ---------- Actions ----------
window.__mark = async pid => {
  const ref = doc(db,"game/current/players",user.uid);
  const me = players.find(p => p.id === user.uid);
  const marks = { ...(me?.marks||{}), [pid]: serverTimestamp() };
  await updateDoc(ref, { marks });
  await addDoc(collection(db,"game/current/feed"), { ts:serverTimestamp(), text:`${user.displayName} marcou uma frase` });
  const ph = await getDoc(GAME); // confere bingo
  if (Object.keys(marks).length >= phrases.length) {
    await updateDoc(GAME, { status:"finished", winnerUid:user.uid, winnerName:user.displayName });
    await addDoc(collection(db,"game/current/feed"), { ts:serverTimestamp(), text:`🎉 BINGO! ${user.displayName} venceu!` });
  }
};
window.__unmark = async pid => {
  const p = players.find(p => p.marks && p.marks[pid]);
  if (!p) return;
  const marks = { ...p.marks }; delete marks[pid];
  await updateDoc(doc(db,"game/current/players",p.id), { marks });
  await addDoc(collection(db,"game/current/feed"), { ts:serverTimestamp(), text:`Admin anulou marcação de ${p.name||p.id}` });
};

function renderRanking() {
  const sorted = [...players].sort((a,b) => Object.keys(b.marks||{}).length - Object.keys(a.marks||{}).length);
  $("ranking").innerHTML = sorted.map(p => `<div class="rank">
    <img src="${p.photoURL||""}"><span style="flex:1">${esc(p.name||"?")}</span>
    <b>${Object.keys(p.marks||{}).length}/${phrases.length}</b></div>`).join("");
}
