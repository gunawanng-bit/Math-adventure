// Fungsi server Vercel: kunci API hanya ada di sini (environment variable), tidak di browser.
const LEVEL = {
  EASY: "mudah: satu langkah, angka kecil",
  CHALLENGE: "menantang: dua langkah",
  HARD: "sulit: beberapa langkah dan penalaran",
  OLYMPIAD: "olimpiade SD: penalaran tinggi, tetap bisa diselesaikan dengan matematika SD",
};

function verify(q) {
  // Hanya ekspresi aritmetika murni yang diperiksa; lainnya dianggap belum terverifikasi.
  if (!q.expr || typeof q.answer !== "number") return null;
  if (!/^[\d+\-*/().\s]+$/.test(q.expr)) return null;
  try {
    const v = Function(`"use strict";return (${q.expr})`)();
    return Math.abs(v - q.answer) < 1e-6;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Gunakan POST" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY belum diatur di server" });
  const b = req.body || {};
  const grade = Number(b.grade), count = Math.min(30, Math.max(1, Number(b.count) || 5));
  const topic = String(b.topic || "").slice(0, 200);
  if (![3, 4, 5, 6].includes(grade) || !topic || !LEVEL[b.diff] || !Array.isArray(b.types) || !b.types.length)
    return res.status(400).json({ error: "Input tidak valid" });
  const web = b.source === "web";
  const candidates = [...new Set([process.env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-3.7-flash", "gemini-2.5-flash-lite"].filter(Boolean))];
  let model = candidates[0];

  const prompt = `Kamu guru matematika SD di Indonesia. Buat ${count} soal ORISINAL dalam bahasa Indonesia.
Kelas: ${grade} SD. Topik: ${topic}. Tingkat: ${LEVEL[b.diff]}.
Jenis soal (bergantian): ${b.types.map(t => String(t).slice(0, 40)).join(", ")}.
Instruksi tambahan: ${String(b.instr || "tidak ada").slice(0, 500)}.
${web ? "Cari referensi soal matematika SD dari sumber pendidikan tepercaya sebagai inspirasi. Jangan menyalin soal; buat soal baru." : ""}
${b.image ? "Gambar terlampir adalah referensi gaya dan materi. Jangan menyalin soalnya." : ""}
Aturan: soal harus benar secara matematis, jelas, tidak ambigu, sesuai kelas, bervariasi (angka, konteks, struktur). Hanya soal, tanpa jawaban di teks soal.
Keluarkan HANYA JSON: {"questions":[{"text":"teks soal","expr":"ekspresi aritmetika murni (angka dan + - * / ( ) saja) yang menghasilkan jawaban, atau kosong","answer":jawaban angka atau null}]}`;

  const parts = [{ text: prompt }];
  const m = typeof b.image === "string" && b.image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });

  const body = { contents: [{ parts }], generationConfig: { temperature: 0.9 } };
  if (web) body.tools = [{ google_search: {} }];
  else body.generationConfig.responseMimeType = "application/json";

  try {
    let d = null, last = "";
    for (const m of candidates) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) { d = j; model = m; break; }
      last += `${m}: ${r.status}; `;
      if (r.status !== 429 && r.status !== 404 && r.status !== 503) break; // galat lain: berhenti
    }
    if (!d) return res.status(502).json({ error: `Semua model ditolak (${last.trim()})` });
    const cand = d.candidates && d.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
    const j = JSON.parse((text.match(/\{[\s\S]*\}/) || [""])[0]);
    const seen = new Set(), out = [];
    let verified = 0;
    for (const q of j.questions || []) {
      if (!q || typeof q.text !== "string" || q.text.length < 10 || seen.has(q.text)) continue;
      const v = verify(q);
      if (v === false) continue; // buang soal yang jawabannya tidak cocok
      if (v === true) verified++;
      seen.add(q.text); out.push(q.text);
    }
    if (!out.length) return res.status(502).json({ error: "AI tidak menghasilkan soal yang valid" });
    const gm = cand && cand.groundingMetadata;
    const sources = web && gm && gm.groundingChunks
      ? gm.groundingChunks.filter(c => c.web).slice(0, 5).map(c => ({ title: c.web.title, uri: c.web.uri })) : [];
    res.status(200).json({ questions: out.slice(0, count), verified, sources, model });
  } catch (e) {
    res.status(502).json({ error: "Gagal memproses jawaban AI" });
  }
};
