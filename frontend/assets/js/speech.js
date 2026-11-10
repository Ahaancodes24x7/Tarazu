// Voice readback of exactly the sentences shown on screen (same numbers).
const BCP = { en: ["en-IN", "en-GB", "en"], hi: ["hi-IN", "hi"], pa: ["pa-IN", "pa-Guru-IN", "pa"] };

function voices() {
  return new Promise(resolve => {
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    speechSynthesis.onvoiceschanged = () => resolve(speechSynthesis.getVoices());
    setTimeout(() => resolve(speechSynthesis.getVoices()), 800);
  });
}

export function canSpeak() { return "speechSynthesis" in window; }

/** Returns {ok, note}. Reads `lines` in `lang`; never paraphrases. */
export async function speak(lines, lang = "en") {
  if (!canSpeak()) return { ok: false, note: "This browser has no speech engine." };
  speechSynthesis.cancel();
  const vs = await voices();
  let voice = null;
  for (const tag of BCP[lang] || BCP.en) {
    voice = vs.find(v => v.lang && v.lang.toLowerCase().startsWith(tag.toLowerCase()));
    if (voice) break;
  }
  const text = lines.join(" ");
  const u = new SpeechSynthesisUtterance(text);
  u.lang = (BCP[lang] || BCP.en)[0];
  if (voice) u.voice = voice;
  u.rate = 0.92;
  speechSynthesis.speak(u);
  return { ok: true, note: voice ? `Voice: ${voice.name}` : `No ${lang.toUpperCase()} voice installed on this device; using the default voice.` };
}

export function stopSpeaking() { if (canSpeak()) speechSynthesis.cancel(); }
