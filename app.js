import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, getDocs,
  addDoc, deleteDoc, onSnapshot, serverTimestamp, query, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

// ---------- Configuração ----------
const firebaseConfig = {
  apiKey: "AIzaSyCkRCAo16Kiv-AlxXg7jRc48bFT99p1nP0",
  authDomain: "bingoleo.firebaseapp.com",
  projectId: "bingoleo",
  storageBucket: "bingoleo.firebasestorage.app",
  messagingSenderId: "394932742416",
  appId: "1:394932742416:web:9dc6f7d566c2fa35b8dd95"
};
const VAPID_KEY =
  "BOkmSROFHMEjJR-9IFBCL7LJKmJLzwFGXVtKQUAKYI4PBAXfXJVOv-a1XrI9CKEXwj0aVupy45TmBj9TjfGF010";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
let messaging = null;
try { messaging = getMessaging(app); } catch (e) { console.warn("Push indisponível:", e); }

const GAME = doc(db, "game/current");
const PHRASES = collection(db, "game/current/phrases");
const PLAYERS = collection(db, "game/current/players");
const FEED = collection(db, "game/current/feed");
const playerRef = uid => doc(db, "game/current/players", uid);

// ---------- Estado ----------
let user = null;
let isAdmin = false;
let game = null;
let phrases = [];
let players = [];
let feed = [];
let started = false;
let lastCanMark = null;

// ---------- Utilidades ----------
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ms = t => (t?.toMillis ? t.toMillis() : (t instanceof Date ? t.getTime() : null));
const fmt = t => {
  const m = ms(t);
  return m ? new Date(m).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
};
const marksOf = p => p?.marks || {};
const me = () => players.find(p => p.id === user?.uid);
const markedBy = phraseId =>
  players
    .filter(p => marksOf(p)[phraseId])
    .sort((a, b) =>
      (ms(marksOf(a)[phraseId]) ?? Number.MAX_SAFE_INTEGER) -
      (ms(marksOf(b)[phraseId]) ?? Number.MAX_SAFE_INTEGER));

const avatar = (p, cls = "av") =>
  p.photoURL
    ? `<img class="${cls}" src="${esc(p.photoURL)}" alt="" title="${esc(p.name || "")}">`
    : `<span class="${cls} init" title="${esc(p.name || "")}">${esc((p.name || "?").trim()[0] || "?")}</span>`;

function flash(text) {
  const box = $("flash");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { box.hidden = true; }, 5000);
}

function say(el, text) { el.textContent = text; }

// ---------- Estado do jogo ----------
function gameState() {
  if (!game) return "none";
  if (game.status === "draft") return "draft";
  if (game.status === "finished") return "finished";
  const s = ms(game.startAt), e = ms(game.endAt);
  if (!s || !e) return "draft";
  const now = Date.now();
  if (now < s) return "soon";
  if (now > e) return "over";
  return "live";
}
const canMark = () => !!user && gameState() === "live";

// ---------- Autenticação ----------
$("authBtn").onclick = async () => {
  try {
    if (user) await signOut(auth);
    else await signInWithPopup(auth, provider);
  } catch (e) {
    flash("Erro ao entrar: " + e.message);
  }
};

onAuthStateChanged(auth, async u => {
  user = u;
  isAdmin = false;

  if (u) {
    try {
      if (u.email) {
        isAdmin = (await getDoc(doc(db, "admins", u.email))).exists();
      }
    } catch (e) {
      console.warn("Não foi possível checar admin:", e);
    }

    // Cria/atualiza o perfil do jogador (sempre, antes de marcar).
    try {
      await setDoc(playerRef(u.uid), {
        name: u.displayName || "",
        photoURL: u.photoURL || ""
      }, { merge: true });
    } catch (e) {
      flash("Não foi possível entrar no placar: " + e.message);
    }

    registerPush(u);

    if (!started) {
      started = true;
      start();
    }
  }

  $("userInfo").innerHTML = u
    ? `<img src="${esc(u.photoURL || "")}" alt="">
       <span>${esc(u.displayName || u.email || "")}</span>`
    : "";
  $("authBtn").textContent = u ? "Sair" : "Entrar com Google";
  $("loginBox").hidden = !!u;
  $("app").hidden = !u;

  render();
});

async function registerPush(u) {
  if (!messaging) return;
  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (token) await setDoc(playerRef(u.uid), { fcmToken: token }, { merge: true });
  } catch (e) {
    console.warn("Notificações indisponíveis:", e);
  }
}

// ---------- Tempo real ----------
function start() {
  const onErr = label => e => flash(`${label}: ${e.message}`);

  onSnapshot(GAME, s => {
    game = s.exists() ? s.data() : null;
    render();
  }, onErr("Erro ao ler o jogo"));

  onSnapshot(query(PHRASES, orderBy("order")), s => {
    phrases = s.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr("Erro ao ler frases"));

  onSnapshot(PLAYERS, s => {
    players = s.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr("Erro ao ler jogadores"));

  onSnapshot(query(FEED, orderBy("ts", "desc")), s => {
    feed = s.docs.map(d => d.data());
    renderFeed();
  }, onErr("Erro ao ler eventos"));
}

// Atualiza o cabeçalho e libera/bloqueia a cartela sem o usuário recarregar.
setInterval(() => {
  if (!user) return;
  renderHeader();
  if (canMark() !== lastCanMark) renderBoard();
}, 1000);

// ---------- Renderização ----------
function render() {
  renderHeader();
  renderAdmin();
  renderBoard();
  renderRanking();
}

function renderHeader() {
  const st = gameState();
  const labels = {
    none: "Sem jogo", draft: "Rascunho", soon: "Em breve",
    live: "Ao vivo", over: "Encerrado", finished: "Encerrado"
  };
  let text = labels[st];
  if (st === "soon") text += ` · começa ${fmt(game.startAt)}`;
  if (st === "live") text += ` · termina ${fmt(game.endAt)}`;
  if (game?.winnerName) text += ` · 🏆 ${game.winnerName}`;

  const pill = $("gameStatus");
  pill.textContent = text;
  pill.classList.toggle("live", st === "live");
}

function renderFeed() {
  $("feed").innerHTML = feed.length
    ? feed.slice(0, 30).map(e => `<li>${esc(e.text)}</li>`).join("")
    : '<li class="muted">Sem eventos ainda.</li>';
}

function renderRanking() {
  const total = phrases.length;
  const sorted = [...players].sort(
    (a, b) => Object.keys(marksOf(b)).length - Object.keys(marksOf(a)).length
  );

  $("ranking").innerHTML = sorted.length
    ? sorted.map((p, i) => {
        const n = Object.keys(marksOf(p)).length;
        const isWinner = game?.winnerUid && p.id === game.winnerUid;
        const you = p.id === user?.uid ? ' <span class="muted">(você)</span>' : "";
        return `
          <div class="rank ${isWinner ? "winner" : ""}">
            <span class="pos">${i + 1}</span>
            ${avatar(p)}
            <span class="name">${esc(p.name || "Jogador")}${you}</span>
            <b>${n}/${total}</b>
          </div>`;
      }).join("")
    : '<p class="muted">Ninguém entrou ainda.</p>';
}

function renderBoard() {
  const box = $("board");
  lastCanMark = canMark();

  if (!phrases.length) {
    box.innerHTML = `<div class="empty">
      ${isAdmin ? "Nenhuma frase ainda. Crie o jogo no painel acima."
                : "Aguarde o admin criar o jogo."}
    </div>`;
    return;
  }

  const open = canMark();
  const mine = marksOf(me());

  box.innerHTML = phrases.map(ph => {
    const holders = markedBy(ph.id);
    const marked = !!mine[ph.id];

    const faces = holders.length
      ? holders.map(p => avatar(p)).join("")
      : '<span class="muted">Ninguém ainda</span>';

    let action = "";
    if (marked) action = '<span class="badge">✓ Você marcou</span>';
    else if (open) action = `<button class="mark" data-mark="${esc(ph.id)}">Marcar</button>`;

    const undo = isAdmin && holders.length
      ? `<button class="ghost small" data-unmark="${esc(ph.id)}">Anular</button>`
      : "";

    return `
      <article class="tile ${marked ? "mine" : ""}">
        <p class="text">${esc(ph.text)}</p>
        <div class="meta">
          <div class="faces">${faces}</div>
          <span class="muted">${holders.length} ${holders.length === 1 ? "marca" : "marcas"}</span>
        </div>
        <div class="actions">${action}${undo}</div>
      </article>`;
  }).join("");
}

// Ações da cartela por delegação (um listener só, sem onclick inline).
$("board").addEventListener("click", e => {
  const markBtn = e.target.closest("[data-mark]");
  if (markBtn) return mark(markBtn.dataset.mark);
  const undoBtn = e.target.closest("[data-unmark]");
  if (undoBtn) return unmark(undoBtn.dataset.unmark);
});

// ---------- Admin ----------
function renderAdmin() {
  const panel = $("adminPanel");
  panel.hidden = !isAdmin;
  if (!isAdmin) return;

  const st = gameState();
  const mode = st === "none" || st === "draft" ? "form" : "control";

  // Só redesenha quando o modo muda, para não apagar o que está sendo digitado.
  if (panel.dataset.mode === mode) return;
  panel.dataset.mode = mode;

  if (mode === "control") {
    panel.innerHTML = `
      <h2>Jogo em andamento</h2>
      <p class="muted">Para anular uma marcação, clique em "Anular" ao lado da frase.</p>
      <div class="row">
        <button class="ghost" id="resetBtn">Zerar jogo</button>
      </div>
      <p class="msg" id="adminMsg"></p>`;
    $("resetBtn").onclick = resetGame;
    return;
  }

  panel.innerHTML = `
    <h2>Criar jogo</h2>
    <label>Frases (uma por linha)
      <textarea id="phrasesTxt" placeholder="Ex.: Alguém usou um emoji de café"></textarea>
    </label>
    <div class="grid2">
      <label>Início <input type="datetime-local" id="startIn"></label>
      <label>Fim <input type="datetime-local" id="endIn"></label>
    </div>
    <div class="row">
      <button id="createBtn">Criar e iniciar</button>
    </div>
    <p class="msg" id="adminMsg"></p>`;
  $("createBtn").onclick = createGame;
}

async function deleteAll(colRef) {
  const snap = await getDocs(colRef);
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// Apaga frases e feed e limpa as marcas de todos os jogadores.
async function clearGameData() {
  await deleteAll(PHRASES);
  await deleteAll(FEED);

  const batch = writeBatch(db);
  players
    .filter(p => Object.keys(marksOf(p)).length)
    .forEach(p => batch.update(playerRef(p.id), { marks: {} }));
  await batch.commit();
}

async function createGame() {
  const msg = $("adminMsg");
  const btn = $("createBtn");

  const list = $("phrasesTxt").value
    .split("\n").map(s => s.trim()).filter(Boolean);
  const start = new Date($("startIn").value);
  const end = new Date($("endIn").value);

  if (list.length < 1) return say(msg, "Digite pelo menos uma frase.");
  if (isNaN(start) || isNaN(end)) return say(msg, "Escolha as datas de início e fim.");
  if (end <= start) return say(msg, "O fim precisa ser depois do início.");
  if (end <= new Date()) return say(msg, "O fim precisa ser no futuro.");

  btn.disabled = true;
  say(msg, "Criando jogo…");
  try {
    await clearGameData();
    await setDoc(GAME, {
      status: "active",
      startAt: start,
      endAt: end,
      createdAt: serverTimestamp(),
      winnerUid: null,
      winnerName: null
    });
    for (const [i, text] of list.entries()) {
      await addDoc(PHRASES, { text, order: i });
    }
    say(msg, "");
    flash("Jogo criado.");
  } catch (e) {
    say(msg, "Não deu certo: " + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function resetGame() {
  try {
    await clearGameData();
    await updateDoc(GAME, { status: "draft", winnerUid: null, winnerName: null });
    flash("Jogo zerado.");
  } catch (e) {
    flash("Erro ao zerar: " + e.message);
  }
}

// ---------- Ações de jogo ----------
async function mark(phraseId) {
  if (!canMark()) return flash("A cartela só está aberta durante o jogo.");
  if (marksOf(me())[phraseId]) return;

  try {
    await setDoc(playerRef(user.uid), {
      name: user.displayName || "",
      photoURL: user.photoURL || "",
      marks: { [phraseId]: serverTimestamp() }
    }, { merge: true });
  } catch (e) {
    flash("Não foi possível marcar: " + e.message);
  }
}

async function unmark(phraseId) {
  if (!isAdmin) return;
  try {
    for (const p of players.filter(p => marksOf(p)[phraseId])) {
      const marks = { ...marksOf(p) };
      delete marks[phraseId];
      await updateDoc(playerRef(p.id), { marks });
    }
  } catch (e) {
    flash("Erro ao anular: " + e.message);
  }
}
