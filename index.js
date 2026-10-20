// npm i firebase-admin firebase-functions
const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();
const sendAll = async (title, body) => {
  const tokens = (await db.collection("game/current/players").get())
    .docs.map(d => d.data().fcmToken).filter(Boolean);
  if (tokens.length) await admin.messaging().sendEachForMulticast({ tokens, notification:{ title, body } });
};
const email = (subject, html) => db.collection("mail").add({ to:"SEU-EMAIL@EXEMPLO.COM", message:{ subject, html } });

// push a cada marcação + evento quente (a 1 frase do bingo)
exports.onMark = onDocumentUpdated("game/current/players/{pid}", async (e) => {
  const before = e.data.before.data().marks || {}, after = e.data.after.data().marks || {};
  const added = Object.keys(after).filter(k => !before[k]);
  if (!added.length) return;
  const p = e.data.after.data();
  const total = (await db.collection("game/current/phrases").get()).size;
  const n = Object.keys(after).length;
  const name = p.name || "Alguém";
  await sendAll("Nova marcação 🎯", `${name} marcou uma frase (${n}/${total})`);
  await db.collection("game/current/feed").add({ ts:admin.firestore.FieldValue.serverTimestamp(),
    text:`${name} marcou uma frase` });
  if (n === total) {
    const g = (await db.doc("game/current").get()).data();
    if (g && g.status === "active") {
      await db.doc("game/current").update({ status:"finished", winnerUid:e.params.pid, winnerName:name });
      await db.collection("game/current/feed").add({ ts:admin.firestore.FieldValue.serverTimestamp(),
        text:`BINGO! ${name} venceu!` });
    }
  }
  if (n === total - 1) {
    await sendAll("⚠️ Evento quente!", `${name} está a 1 frase do bingo!`);
    await db.collection("game/current/feed").add({ ts:admin.firestore.FieldValue.serverTimestamp(),
      text:`🔥 ${name} está a 1 frase do bingo!` });
  }
});

// email + push quando alguém binga
exports.onBingo = onDocumentCreated("game/current/feed/{id}", async (e) => {
  const t = e.data.data().text || "";
  if (t.includes("BINGO")) { await sendAll("🎉 BINGO!", t); await email("Bingo - vencedor", `<p>${t}</p>`); }
});

// finaliza no fim do prazo: vence quem tem mais; desempate = primeiro a marcar a última frase
exports.finalize = onSchedule("every 1 minutes", async () => {
  const g = (await db.doc("game/current").get()).data();
  if (!g || g.status !== "active" || Date.now() <= g.endAt.toMillis()) return;
  const ps = (await db.collection("game/current/players").get()).docs
    .map(d => ({ id:d.id, ...d.data() }));
  const total = (await db.collection("game/current/phrases").get()).size;
  if (!ps.length) { await db.doc("game/current").update({ status:"finished" }); return; }
  const score = p => { const m = Object.entries(p.marks||{}); return m.length; };
  const lastTs = p => Math.max(...Object.values(p.marks||{}).map(t => t.toMillis()));
  ps.sort((a,b) => score(b)-score(a) || lastTs(a)-lastTs(b));
  const w = ps[0];
  await db.doc("game/current").update({ status:"finished", winnerUid:w.id, winnerName:w.name });
  await sendAll("🏁 Jogo encerrado", `Vencedor: ${w.name} (${score(w)}/${total})`);
  await email("Bingo encerrado", `<p>Vencedor: <b>${w.name}</b> com ${score(w)}/${total} frases.</p>`);
});
