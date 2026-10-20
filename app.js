import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  updateDoc,
  collection,
  getDocs,
  addDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMessaging,
  getToken
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

// Firebase
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
const messaging = getMessaging(app);

const GAME = doc(db, "game/current");
const provider = new GoogleAuthProvider();

let user = null;
let isAdmin = false;
let game = null;
let phrases = [];
let players = [];
let started = false;

const $ = id => document.getElementById(id);

const esc = value =>
  String(value ?? "").replace(/[&<>"]/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));

function showError(context, error) {
  console.error(`[Bingoleo] ${context}:`, error);

  const message = error?.message || String(error);
  $("gameStatus").textContent = `${context}: ${message}`;
}

// ---------- Auth ----------

$("authBtn").onclick = async () => {
  try {
    if (user) {
      await signOut(auth);
    } else {
      await signInWithPopup(auth, provider);
    }
  } catch (error) {
    showError("Erro de autenticação", error);
  }
};

onAuthStateChanged(auth, async u => {
  user = u;
  isAdmin = false;

  if (u) {
    console.log("Conta autenticada:", u.email);

    try {
      if (!u.email) {
        throw new Error("A conta Google não retornou um e-mail.");
      }

      const adminRef = doc(db, "admins", u.email);
      const adminSnapshot = await getDoc(adminRef);

      isAdmin = adminSnapshot.exists();

      console.log("Documento de administrador:", adminSnapshot.exists());

      if (!isAdmin) {
        console.warn(
          "Admin não encontrado. Confira se o ID do documento " +
          "em admins corresponde exatamente ao e-mail autenticado:",
          u.email
        );
      }
    } catch (error) {
      isAdmin = false;
      showError("Erro ao verificar administrador", error);
    }

    // Garante o documento do jogador (necessário para marcar frases),
    // independente de notificações.
    try {
      await setDoc(
        doc(db, "game/current/players", u.uid),
        {
          name: u.displayName || "",
          photoURL: u.photoURL || ""
        },
        { merge: true }
      );
    } catch (error) {
      showError("Erro ao registrar jogador", error);
    }

    // Registro de notificações: falhas aqui não bloqueiam o acesso.
    try {
      const token = await getToken(messaging, {
        vapidKey: VAPID_KEY
      });

      if (token) {
        await setDoc(
          doc(db, "game/current/players", u.uid),
          {
            name: u.displayName || "",
            photoURL: u.photoURL || "",
            fcmToken: token
          },
          { merge: true }
        );
      }
    } catch (error) {
      console.warn("Notificações indisponíveis:", error);
    }
  }

  $("userInfo").innerHTML = u
    ? `<img src="${esc(u.photoURL)}" width="28"
         style="border-radius:50%;vertical-align:middle">
       ${esc(u.displayName || u.email || "")}`
    : "";

  $("authBtn").textContent = u ? "Sair" : "Entrar com Google";
  $("loginBox").style.display = u ? "none" : "grid";
  $("app").style.display = u ? "block" : "none";

  if (!u) {
    $("adminPanel").style.display = "none";
    $("gameStatus").textContent = "Faça login para participar.";
    return;
  }

  if (isAdmin) {
    console.log("Acesso administrativo autorizado.");
  }

  if (!started) {
    started = true;
    start();
  }

  renderGame();
});

// ---------- Realtime ----------

function start() {
  onSnapshot(
    GAME,
    snapshot => {
      game = snapshot.exists() ? snapshot.data() : null;
      renderGame();
    },
    error => showError("Erro ao ler o jogo", error)
  );

  onSnapshot(
    query(collection(db, "game/current/phrases"), orderBy("order")),
    snapshot => {
      phrases = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      renderBoard();
      renderRanking();
    },
    error => showError("Erro ao ler frases", error)
  );

  onSnapshot(
    collection(db, "game/current/players"),
    snapshot => {
      players = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      renderBoard();
      renderRanking();
    },
    error => showError("Erro ao ler jogadores", error)
  );

  onSnapshot(
    query(
      collection(db, "game/current/feed"),
      orderBy("ts", "desc")
    ),
    snapshot => {
      $("feed").innerHTML = snapshot.docs
        .slice(0, 20)
        .map(d => `<li>${esc(d.data().text)}</li>`)
        .join("");
    },
    error => showError("Erro ao ler eventos", error)
  );
}

const active = () =>
  !!game &&
  game.status === "active" &&
  !!game.startAt &&
  !!game.endAt &&
  Date.now() >= game.startAt.toMillis() &&
  Date.now() <= game.endAt.toMillis();

// ---------- Game ----------

function renderGame() {
  if (!game) {
    $("gameStatus").textContent = "Aguardando admin criar o jogo";

    // O painel precisa aparecer mesmo sem game/current.
    if (isAdmin) {
      renderAdmin();
    } else {
      $("adminPanel").style.display = "none";
    }

    return;
  }

  const status = {
    draft: "Rascunho",
    active: "Ativo",
    finished: "Encerrado"
  }[game.status] || "Status desconhecido";

  const winner = game.winnerName
    ? ` | 🏆 ${esc(game.winnerName)}`
    : "";

  $("gameStatus").textContent = `${status}${winner}`;

  if (isAdmin) {
    renderAdmin();
  } else {
    $("adminPanel").style.display = "none";
  }

  renderBoard();
  renderRanking();
}

// ---------- Admin ----------

function renderAdmin() {
  const panel = $("adminPanel");

  // Corrige o display:none definido no index.html.
  panel.style.display = "block";

  if (game && game.status !== "draft") {
    panel.innerHTML = `
      <div class="card">
        <h3>Admin</h3>
        <p class="muted">
          Jogo ${esc(game.status)}. Clique em uma foto marcada
          para anular a marcação.
        </p>
        <button class="ghost" id="resetBtn">Zerar jogo</button>
      </div>
    `;

    $("resetBtn").onclick = async () => {
      try {
        await resetGame();
      } catch (error) {
        showError("Erro ao zerar jogo", error);
      }
    };

    return;
  }

  panel.innerHTML = `
    <div class="card">
      <h3>Criar jogo (admin)</h3>
      <label for="phrasesTxt">Uma frase por linha</label>
      <textarea
        id="phrasesTxt"
        rows="8"
        placeholder="Digite uma frase por linha"
      ></textarea>

      <div class="row">
        <input type="datetime-local" id="startIn"
               aria-label="Início do jogo">
        <input type="datetime-local" id="endIn"
               aria-label="Fim do jogo">
      </div>

      <button id="createBtn">Criar e iniciar</button>
      <p id="createError" class="muted"></p>
    </div>
  `;

  $("createBtn").onclick = async () => {
    const button = $("createBtn");
    const errorBox = $("createError");

    try {
      if (!isAdmin || !user) {
        throw new Error("Sua conta não foi reconhecida como administradora.");
      }

      const list = $("phrasesTxt").value
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean);

      if (list.length === 0) {
        throw new Error("Digite pelo menos uma frase.");
      }

      const startValue = $("startIn").value;
      const endValue = $("endIn").value;

      if (!startValue || !endValue) {
        throw new Error("Preencha as datas de início e fim.");
      }

      const startDate = new Date(startValue);
      const endDate = new Date(endValue);

      if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime())
      ) {
        throw new Error("Uma das datas é inválida.");
      }

      if (endDate <= startDate) {
        throw new Error("O fim deve ser posterior ao início.");
      }

      button.disabled = true;
      button.textContent = "Criando jogo...";
      errorBox.textContent = "";

      await setDoc(GAME, {
        status: "active",
        startAt: startDate,
        endAt: endDate,
        createdAt: serverTimestamp(),
        winnerUid: null,
        winnerName: null
      });

      for (let i = 0; i < list.length; i++) {
        await addDoc(
          collection(db, "game/current/phrases"),
          {
            text: list[i],
            order: i
          }
        );
      }

      console.log("Jogo criado com sucesso.");
    } catch (error) {
      console.error("Erro ao criar jogo:", error);

      errorBox.textContent =
        `Não foi possível criar o jogo: ${error.message}`;

      button.disabled = false;
      button.textContent = "Criar e iniciar";
    }
  };
}

async function resetGame() {
  if (!isAdmin) {
    throw new Error("Apenas administradores podem zerar o jogo.");
  }

  const phraseSnapshots = await getDocs(
    collection(db, "game/current/phrases")
  );

  for (const snapshot of phraseSnapshots.docs) {
    await deleteDoc(snapshot.ref);
  }

  const feedSnapshots = await getDocs(
    collection(db, "game/current/feed")
  );

  for (const snapshot of feedSnapshots.docs) {
    await deleteDoc(snapshot.ref);
  }

  await updateDoc(GAME, {
    status: "draft",
    winnerUid: null,
    winnerName: null
  });
}

// ---------- Board ----------

function renderBoard() {
  if (!phrases.length) {
    $("board").innerHTML =
      '<p class="muted">Nenhuma frase ainda.</p>';
    return;
  }

  $("board").innerHTML = phrases.map(phrase => {
    const markers = players
      .filter(player =>
        player.marks && player.marks[phrase.id]
      )
      .sort((a, b) =>
        a.marks[phrase.id].toMillis() -
        b.marks[phrase.id].toMillis()
      );

    const circles = markers.map(player => `
      <div class="circle" title="${esc(player.name || "")}">
        <img src="${esc(player.photoURL || "")}" alt="">
      </div>
    `).join("") +
      '<div class="circle empty"></div>'.repeat(
        Math.max(players.length - markers.length, 0)
      );

    const mine = user &&
      markers.some(player => player.id === user.uid);

    const unmarkButton =
      isAdmin && markers.length
        ? `<button class="ghost"
             style="padding:2px 8px;font-size:11px"
             onclick="window.__unmark('${phrase.id}')">
             Anular
           </button>`
        : "";

    const canMark = active() && user && !mine;

    const clickable = canMark
      ? `onclick="window.__mark('${phrase.id}')"
         style="cursor:pointer"`
      : "";

    const voteButton = canMark
      ? `<button class="vote" onclick="window.__mark('${phrase.id}')">Marcar</button>`
      : mine
        ? '<span class="muted">✓ Marcada por você</span>'
        : "";

    return `
      <div class="phraseBox ${mine ? "mine" : ""}">
        <p>${esc(phrase.text)} ${unmarkButton}</p>
        <div class="avatars" ${clickable}>${circles}</div>
        <div class="votes">${voteButton}</div>
      </div>
    `;
  }).join("");
}

// ---------- Actions ----------

window.__mark = async phraseId => {
  try {
    if (!user || !active()) return;

    const ref = doc(db, "game/current/players", user.uid);
    const me = players.find(player => player.id === user.uid);

    const marks = {
      ...(me?.marks || {}),
      [phraseId]: serverTimestamp()
    };

    await setDoc(
      ref,
      {
        name: user.displayName || "",
        photoURL: user.photoURL || "",
        marks: { [phraseId]: serverTimestamp() }
      },
      { merge: true }
    );

    // O feed de marcação é gravado pela Cloud Function onMark.

    if (Object.keys(marks).length >= phrases.length) {
      await updateDoc(GAME, {
        status: "finished",
        winnerUid: user.uid,
        winnerName: user.displayName || "Jogador"
      });

      await addDoc(collection(db, "game/current/feed"), {
        ts: serverTimestamp(),
        text: `BINGO! ${user.displayName || "Jogador"} venceu!`
      });
    }
  } catch (error) {
    showError("Erro ao marcar frase", error);
  }
};

window.__unmark = async phraseId => {
  try {
    if (!isAdmin) {
      throw new Error("Apenas administradores podem anular marcações.");
    }

    const player = players.find(p =>
      p.marks && p.marks[phraseId]
    );

    if (!player) return;

    const marks = { ...player.marks };
    delete marks[phraseId];

    await updateDoc(
      doc(db, "game/current/players", player.id),
      { marks }
    );

    await addDoc(collection(db, "game/current/feed"), {
      ts: serverTimestamp(),
      text: `Admin anulou marcação de ${player.name || player.id}`
    });
  } catch (error) {
    showError("Erro ao anular marcação", error);
  }
};

// ---------- Ranking ----------

function renderRanking() {
  const sorted = [...players].sort(
    (a, b) =>
      Object.keys(b.marks || {}).length -
      Object.keys(a.marks || {}).length
  );

  $("ranking").innerHTML = sorted.map(player => `
    <div class="rank">
      <img src="${esc(player.photoURL || "")}" alt="">
      <span style="flex:1">${esc(player.name || "?")}</span>
      <b>${Object.keys(player.marks || {}).length}/${phrases.length}</b>
    </div>
  `).join("");
}

// Atualiza o tabuleiro quando o jogo abre/fecha pelo horário.
setInterval(() => { if (user) renderBoard(); }, 15000);
