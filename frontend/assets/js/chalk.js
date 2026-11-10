// Chalkboard live demo. Every number written on the board comes from POST /api/quick;
// this file only lays the engine's answer out as seven teaching steps, in English, Hindi or Punjabi.
// The engine localises explanation titles, check wording, record labels and the spoken sentences;
// the board's own words come from the table below. Hindi and Punjabi need a native-speaker review.
import { api } from "./api.js";
import { speak } from "./speech.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const g3 = x => (Math.abs(+x) < 5e-5 ? 0 : +x).toFixed(3);

const SCEN = {
  worked: { fin: "0.916", issue: 100, finished: 95, scrap: 4, wastage: 0, u: 2 },
  clean: { fin: "0.925", issue: 50, finished: 49.52, scrap: 0.45, wastage: 0.1, u: 2 },
  stone: { fin: "0.925", issue: 25, finished: 25.3, scrap: 0.04, wastage: 0.1, u: 2 },
};
const metalOf = fin => (+fin === 0.916 || +fin === 0.75 ? "gold" : "silver");

/* ------------------------------------------------------------ words on the board */
const TX = {
  en: {
    steps: ["The job", "Only pure metal has to balance", "The gap", "Real gap, or just scale noise?", "What could explain it?", "The most informative next check", "What both sides see and hear"],
    shorts: ["Job", "Fine metal", "Gap", "Noise?", "Explanations", "Next check", "Wording"],
    stepOf: "Step {i} of {n}", foot: "Computed by the Tarazu engine on this machine in {ms} ms", solver: "solver", saved: "nothing is saved",
    fin: { "0.999": "fine silver", "0.925": "sterling silver", "0.916": "22 K gold", "0.750": "18 K gold" }, metal: { gold: "gold", silver: "silver" },
    give: "Jeweller gives the karigar {g} of {name}", purity: "purity φ = {fin} (that share of each gram is pure {metal})",
    brings: "Karigar brings back:", jewellery: "jewellery", scrap: "scrap & sweepings", agreed: "Agreed wastage: up to {w}", scaleAcc: "scale accuracy: {u}",
    n1t: "Nothing new to learn", n1: "These are the slips both sides already write. Change any number on the chalk tray below and the whole board recalculates.",
    pureEq: "pure metal = weight × purity", out: "Went out", back: "Came back", tIssue: "Issued", tFin: "Jewellery back", tScrap: "Scrap back",
    deduct: "Stones & fixtures deducted: {g}", pureOut: "Pure metal out {a} back {b}",
    n2t: "Why only pure metal?", n2: "The copper or zinc alloyed into jewellery isn't what anyone is arguing about. Comparing pure grams makes a 22 K ring and 24 K scrap comparable.",
    pure: "pure metal", notBack: "went out but has not come back yet", moreBack: "more came back than went out",
    allowed: "Wastage allowed: up to {g} ({w}% of {f})", beyond: "Beyond the allowance: {g}", surplus: "Surplus: {g} more returned than issued", fits: "The gap fits inside the allowance.",
    n3t: "A plain ledger stops here", n3: "…and raises a red flag on any gap. Tarazu asks one more question first: could this gap just be the scale?",
    range: "Every weighing is only accurate to ± {u} mg, so the gap is a range, not a point:", inRange: "gap is somewhere in {r}",
    vBal: "{b} The interval touches the allowance, so Tarazu stays silent.", vBalW: "Balanced.",
    vSur: "{b} Even at the extremes, more came back than went out.", vSurW: "Real surplus.",
    vGap: "{b} Even at the extremes, it is past the allowance.", vGapW: "Real gap.",
    zero: "0 = perfect balance", allowBand: "allowed wastage", noAllow: "no wastage allowed", gapNoise: "the gap, with scale noise",
    n4t: "No false alarms", n4: "If zero or the allowance falls inside the range, the gap could be noise, and accusing an honest karigar over noise destroys trust. Tarazu only speaks when the whole range is clear.",
    nothing: "Nothing to explain.", nothingD: "The gap sits inside measurement noise and the agreed wastage.",
    n5bt: "Silence is a result", n5b: "Most jobs end here. Try the “Worked example” on the tray to see an unexplained gap.",
    tried: "Tried {n} possible fixes · {k} fit the numbers exactly:", more: "…and {n} less likely ones. “Process loss beyond wastage” is offered only once all of these are ruled out.",
    n5t: "Each line is one small, specific fix", n5: "Each would close the gap exactly. Physically impossible fixes are thrown out. The percentages are the engine's relative weights, favouring simple explanations; they are not calibrated probabilities.",
    noCheck: "No check needed.", n6zt: "Zero minutes spent", n6z: "Nobody has to recount anything when the books already balance.",
    ruled: "ruled out {n}", settled: "Settled:", unres: "Unresolved.", unresD: "No affordable check can separate what's left, so Tarazu says so instead of guessing.",
    unexp: "No listed explanation fits.", unexpD: "Time for a full recount.", confirmWith: "Confirm with:", askNext: "Ask next:", cost: "{m} min · removes {b} bits of doubt",
    thAll: "all checks, ranked", thMin: "minutes", thGain: "doubt removed per unit effort", yourTurn: "← your turn: tap what the check found", again: "↺ start the check again",
    n6t: "Most information per minute", n6: "Tarazu picks the check that removes the most doubt per minute of effort, and stops as soon as one explanation is clear. Effort counts minutes plus how awkward the check is for the relationship.",
    readAloud: "🔊 Read it aloud", nextWb: "Next, in the workbench: the fix is added as a correction, never an edit, and the settlement stays a draft until both sides approve.",
    n7t: "Never “missing”, “lost” or “stolen”", n7: "Only “unaccounted for”, in English, Hindi and Punjabi. The voice reads exactly these sentences, same numbers.",
    offline: "The engine isn't running. Start it with  python run.py  and reload.", needIssue: "Enter how much metal was issued to start.",
    tray: { worked: "Worked example · 22 K gold", clean: "Clean job · silver", stone: "Stone left in · silver", issue: "Issued", finished: "Jewellery back", scrapF: "Scrap back", fin: "Fineness", wastage: "Wastage allowed", u: "Scale ±" },
    outcome: {},
  },
  hi: {
    steps: ["काम", "सिर्फ़ शुद्ध धातु का हिसाब बराबर होना चाहिए", "अंतर", "असली अंतर, या सिर्फ़ तराज़ू की चूक?", "इसकी वजह क्या हो सकती है?", "सबसे काम की अगली जाँच", "दोनों पक्ष क्या देखते और सुनते हैं"],
    shorts: ["काम", "शुद्ध धातु", "अंतर", "चूक?", "वजहें", "अगली जाँच", "शब्द"],
    stepOf: "चरण {i} / {n}", foot: "इस मशीन पर तराज़ू इंजन ने {ms} ms में हिसाब लगाया", solver: "सॉल्वर", saved: "कुछ भी सहेजा नहीं जाता",
    fin: { "0.999": "शुद्ध चाँदी", "0.925": "स्टर्लिंग चाँदी", "0.916": "22 कैरेट सोना", "0.750": "18 कैरेट सोना" }, metal: { gold: "सोना", silver: "चाँदी" },
    give: "ज्वैलर कारीगर को {name} {g} देता है", purity: "शुद्धता φ = {fin} (हर ग्राम में इतना हिस्सा शुद्ध {metal} है)",
    brings: "कारीगर वापस लाता है:", jewellery: "गहने", scrap: "स्क्रैप और झाड़न", agreed: "तय छीजत: {w} तक", scaleAcc: "तराज़ू की सटीकता: {u}",
    n1t: "कुछ नया नहीं सीखना", n1: "ये वही पर्चियाँ हैं जो दोनों पक्ष पहले से लिखते हैं। नीचे ट्रे में कोई भी संख्या बदलें, पूरा बोर्ड फिर से हिसाब लगाएगा।",
    pureEq: "शुद्ध धातु = वज़न × शुद्धता", out: "बाहर गया", back: "वापस आया", tIssue: "जारी", tFin: "गहने वापस", tScrap: "स्क्रैप वापस",
    deduct: "नग और फ़िटिंग घटाए: {g}", pureOut: "शुद्ध धातु बाहर {a} वापस {b}",
    n2t: "सिर्फ़ शुद्ध धातु क्यों?", n2: "गहनों में मिलाया गया ताँबा या जस्ता विवाद का विषय नहीं है। शुद्ध ग्राम की तुलना से 22 कैरेट की अंगूठी और 24 कैरेट स्क्रैप बराबर तौले जा सकते हैं।",
    pure: "शुद्ध धातु", notBack: "बाहर गया पर अभी वापस नहीं आया", moreBack: "जितना गया उससे ज़्यादा वापस आया",
    allowed: "अनुमत छीजत: {g} तक ({f} का {w}%)", beyond: "छूट से ज़्यादा: {g}", surplus: "अधिशेष: जारी से {g} ज़्यादा वापस", fits: "अंतर छूट के भीतर है।",
    n3t: "साधारण बही यहीं रुक जाती है", n3: "…और हर अंतर पर लाल झंडा उठाती है। तराज़ू पहले एक सवाल और पूछता है: कहीं यह अंतर सिर्फ़ तराज़ू की चूक तो नहीं?",
    range: "हर तौल सिर्फ़ ± {u} mg तक सटीक है, इसलिए अंतर एक बिंदु नहीं, एक दायरा है:", inRange: "अंतर इस दायरे में है: {r}",
    vBal: "{b} दायरा छूट को छूता है, इसलिए तराज़ू चुप रहता है।", vBalW: "बराबर।",
    vSur: "{b} चरम स्थिति में भी जितना गया उससे ज़्यादा वापस आया।", vSurW: "असली अधिशेष।",
    vGap: "{b} चरम स्थिति में भी यह छूट से बाहर है।", vGapW: "असली अंतर।",
    zero: "0 = पूरा बराबर", allowBand: "अनुमत छीजत", noAllow: "कोई छीजत तय नहीं", gapNoise: "अंतर, तराज़ू की चूक सहित",
    n4t: "झूठी चेतावनी नहीं", n4: "अगर शून्य या छूट दायरे में आती है तो अंतर सिर्फ़ चूक हो सकता है, और उस पर ईमानदार कारीगर पर शक करना भरोसा तोड़ता है। तराज़ू तभी बोलता है जब पूरा दायरा साफ़ हो।",
    nothing: "समझाने को कुछ नहीं।", nothingD: "अंतर माप की चूक और तय छीजत के भीतर है।",
    n5bt: "चुप रहना भी एक नतीजा है", n5b: "ज़्यादातर काम यहीं ख़त्म होते हैं। बिना समझाए अंतर देखने के लिए ट्रे पर “उदाहरण” चुनें।",
    tried: "{n} संभावित सुधार आज़माए · {k} संख्याओं से पूरी तरह मेल खाते हैं:", more: "…और {n} कम संभावित। “छीजत से ज़्यादा नुकसान” तभी दिखाया जाता है जब ये सब ख़ारिज हो जाएँ।",
    n5t: "हर पंक्ति एक छोटा, ठोस सुधार है", n5: "हर एक अंतर को ठीक-ठीक बंद कर देगा। भौतिक रूप से असंभव सुधार हटा दिए जाते हैं। प्रतिशत इंजन का सापेक्ष भार है, जो सरल वजहों को तरजीह देता है; यह संभावना नहीं है।",
    noCheck: "कोई जाँच नहीं चाहिए।", n6zt: "शून्य मिनट", n6z: "जब हिसाब पहले से बराबर है तो किसी को दोबारा गिनना नहीं पड़ता।",
    ruled: "{n} ख़ारिज", settled: "सुलझा:", unres: "नहीं सुलझा।", unresD: "कोई किफ़ायती जाँच बची वजहों को अलग नहीं कर सकती, इसलिए तराज़ू अंदाज़ा लगाने के बजाय यही बताता है।",
    unexp: "कोई सूचीबद्ध वजह मेल नहीं खाती।", unexpD: "पूरी दोबारा गिनती का समय है।", confirmWith: "पुष्टि करें:", askNext: "अगली जाँच:", cost: "{m} मिनट · {b} बिट शक दूर करता है",
    thAll: "सभी जाँचें, क्रम से", thMin: "मिनट", thGain: "प्रति मेहनत शक कितना घटा", yourTurn: "← आपकी बारी: जाँच में जो मिला उसे चुनें", again: "↺ जाँच फिर से शुरू करें",
    n6t: "हर मिनट में सबसे ज़्यादा जानकारी", n6: "तराज़ू वह जाँच चुनता है जो प्रति मिनट सबसे ज़्यादा शक दूर करे, और एक वजह साफ़ होते ही रुक जाता है। मेहनत में मिनट और रिश्ते पर पड़ने वाला असर दोनों गिने जाते हैं।",
    readAloud: "🔊 पढ़कर सुनाएँ", nextWb: "आगे वर्कबेंच में: सुधार एक नई प्रविष्टि के रूप में जुड़ता है, पुरानी कभी नहीं बदलती, और दोनों पक्षों की मंज़ूरी तक हिसाब मसौदा रहता है।",
    n7t: "कभी “गायब”, “खोया” या “चोरी” नहीं", n7: "सिर्फ़ “हिसाब नहीं मिल रहा”, हिंदी, अंग्रेज़ी और पंजाबी में। आवाज़ ठीक यही वाक्य, यही संख्याएँ पढ़ती है।",
    offline: "इंजन नहीं चल रहा। python run.py से शुरू करें और पेज दोबारा खोलें।", needIssue: "शुरू करने के लिए जारी धातु दर्ज करें।",
    tray: { worked: "उदाहरण · 22 कैरेट सोना", clean: "साफ़ काम · चाँदी", stone: "नग रह गया · चाँदी", issue: "जारी", finished: "गहने वापस", scrapF: "स्क्रैप वापस", fin: "शुद्धता", wastage: "अनुमत छीजत", u: "तराज़ू ±" },
    outcome: { "extra piece found": "एक अतिरिक्त पीस मिला", "count matches": "गिनती मेल खाती है", "unlogged scrap found": "बिना दर्ज स्क्रैप मिला", "nothing extra": "कुछ अतिरिक्त नहीं",
      "weight differs from entry": "वज़न प्रविष्टि से अलग है", "weight matches entry": "वज़न प्रविष्टि से मेल खाता है", "item found at bench": "बेंच पर सामान मिला", "bench clear": "बेंच ख़ाली है",
      "same slip and time": "वही पर्ची और समय", "distinct slips": "अलग-अलग पर्चियाँ" },
  },
  pa: {
    steps: ["ਕੰਮ", "ਸਿਰਫ਼ ਸ਼ੁੱਧ ਧਾਤ ਦਾ ਹਿਸਾਬ ਬਰਾਬਰ ਹੋਣਾ ਚਾਹੀਦਾ ਹੈ", "ਫ਼ਰਕ", "ਅਸਲੀ ਫ਼ਰਕ, ਜਾਂ ਸਿਰਫ਼ ਤੱਕੜੀ ਦੀ ਚੂਕ?", "ਇਸ ਦਾ ਕਾਰਨ ਕੀ ਹੋ ਸਕਦਾ ਹੈ?", "ਸਭ ਤੋਂ ਕੰਮ ਦੀ ਅਗਲੀ ਜਾਂਚ", "ਦੋਵੇਂ ਧਿਰਾਂ ਕੀ ਦੇਖਦੀਆਂ ਤੇ ਸੁਣਦੀਆਂ ਹਨ"],
    shorts: ["ਕੰਮ", "ਸ਼ੁੱਧ ਧਾਤ", "ਫ਼ਰਕ", "ਚੂਕ?", "ਕਾਰਨ", "ਅਗਲੀ ਜਾਂਚ", "ਸ਼ਬਦ"],
    stepOf: "ਕਦਮ {i} / {n}", foot: "ਇਸ ਮਸ਼ੀਨ 'ਤੇ ਤਰਾਜ਼ੂ ਇੰਜਣ ਨੇ {ms} ms ਵਿੱਚ ਹਿਸਾਬ ਲਾਇਆ", solver: "ਸੌਲਵਰ", saved: "ਕੁਝ ਵੀ ਸੰਭਾਲਿਆ ਨਹੀਂ ਜਾਂਦਾ",
    fin: { "0.999": "ਸ਼ੁੱਧ ਚਾਂਦੀ", "0.925": "ਸਟਰਲਿੰਗ ਚਾਂਦੀ", "0.916": "22 ਕੈਰਟ ਸੋਨਾ", "0.750": "18 ਕੈਰਟ ਸੋਨਾ" }, metal: { gold: "ਸੋਨਾ", silver: "ਚਾਂਦੀ" },
    give: "ਜਿਊਲਰ ਕਾਰੀਗਰ ਨੂੰ {name} {g} ਦਿੰਦਾ ਹੈ", purity: "ਸ਼ੁੱਧਤਾ φ = {fin} (ਹਰ ਗ੍ਰਾਮ ਵਿੱਚ ਇੰਨਾ ਹਿੱਸਾ ਸ਼ੁੱਧ {metal} ਹੈ)",
    brings: "ਕਾਰੀਗਰ ਵਾਪਸ ਲਿਆਉਂਦਾ ਹੈ:", jewellery: "ਗਹਿਣੇ", scrap: "ਸਕ੍ਰੈਪ ਤੇ ਝਾੜਨ", agreed: "ਤੈਅ ਛੀਜਤ: {w} ਤੱਕ", scaleAcc: "ਤੱਕੜੀ ਦੀ ਸ਼ੁੱਧਤਾ: {u}",
    n1t: "ਕੁਝ ਨਵਾਂ ਨਹੀਂ ਸਿੱਖਣਾ", n1: "ਇਹ ਉਹੀ ਪਰਚੀਆਂ ਹਨ ਜੋ ਦੋਵੇਂ ਧਿਰਾਂ ਪਹਿਲਾਂ ਹੀ ਲਿਖਦੀਆਂ ਹਨ। ਹੇਠਾਂ ਟ੍ਰੇ ਵਿੱਚ ਕੋਈ ਵੀ ਅੰਕ ਬਦਲੋ, ਸਾਰਾ ਬੋਰਡ ਮੁੜ ਹਿਸਾਬ ਲਾਏਗਾ।",
    pureEq: "ਸ਼ੁੱਧ ਧਾਤ = ਵਜ਼ਨ × ਸ਼ੁੱਧਤਾ", out: "ਬਾਹਰ ਗਿਆ", back: "ਵਾਪਸ ਆਇਆ", tIssue: "ਜਾਰੀ", tFin: "ਗਹਿਣੇ ਵਾਪਸ", tScrap: "ਸਕ੍ਰੈਪ ਵਾਪਸ",
    deduct: "ਨਗ ਤੇ ਫ਼ਿਟਿੰਗ ਘਟਾਏ: {g}", pureOut: "ਸ਼ੁੱਧ ਧਾਤ ਬਾਹਰ {a} ਵਾਪਸ {b}",
    n2t: "ਸਿਰਫ਼ ਸ਼ੁੱਧ ਧਾਤ ਕਿਉਂ?", n2: "ਗਹਿਣਿਆਂ ਵਿੱਚ ਮਿਲਾਇਆ ਤਾਂਬਾ ਜਾਂ ਜਿਸਤ ਝਗੜੇ ਦਾ ਵਿਸ਼ਾ ਨਹੀਂ। ਸ਼ੁੱਧ ਗ੍ਰਾਮ ਦੀ ਤੁਲਨਾ ਨਾਲ 22 ਕੈਰਟ ਦੀ ਮੁੰਦਰੀ ਤੇ 24 ਕੈਰਟ ਸਕ੍ਰੈਪ ਬਰਾਬਰ ਤੋਲੇ ਜਾ ਸਕਦੇ ਹਨ।",
    pure: "ਸ਼ੁੱਧ ਧਾਤ", notBack: "ਬਾਹਰ ਗਿਆ ਪਰ ਅਜੇ ਵਾਪਸ ਨਹੀਂ ਆਇਆ", moreBack: "ਜਿੰਨਾ ਗਿਆ ਉਸ ਤੋਂ ਵੱਧ ਵਾਪਸ ਆਇਆ",
    allowed: "ਮਨਜ਼ੂਰ ਛੀਜਤ: {g} ਤੱਕ ({f} ਦਾ {w}%)", beyond: "ਛੋਟ ਤੋਂ ਵੱਧ: {g}", surplus: "ਵਾਧਾ: ਜਾਰੀ ਤੋਂ {g} ਵੱਧ ਵਾਪਸ", fits: "ਫ਼ਰਕ ਛੋਟ ਦੇ ਅੰਦਰ ਹੈ।",
    n3t: "ਸਾਧਾਰਨ ਵਹੀ ਇੱਥੇ ਹੀ ਰੁਕ ਜਾਂਦੀ ਹੈ", n3: "…ਅਤੇ ਹਰ ਫ਼ਰਕ 'ਤੇ ਲਾਲ ਝੰਡਾ ਚੁੱਕਦੀ ਹੈ। ਤਰਾਜ਼ੂ ਪਹਿਲਾਂ ਇੱਕ ਸਵਾਲ ਹੋਰ ਪੁੱਛਦਾ ਹੈ: ਕਿਤੇ ਇਹ ਫ਼ਰਕ ਸਿਰਫ਼ ਤੱਕੜੀ ਦੀ ਚੂਕ ਤਾਂ ਨਹੀਂ?",
    range: "ਹਰ ਤੋਲ ਸਿਰਫ਼ ± {u} mg ਤੱਕ ਸਹੀ ਹੈ, ਇਸ ਲਈ ਫ਼ਰਕ ਇੱਕ ਬਿੰਦੂ ਨਹੀਂ, ਇੱਕ ਦਾਇਰਾ ਹੈ:", inRange: "ਫ਼ਰਕ ਇਸ ਦਾਇਰੇ ਵਿੱਚ ਹੈ: {r}",
    vBal: "{b} ਦਾਇਰਾ ਛੋਟ ਨੂੰ ਛੂੰਹਦਾ ਹੈ, ਇਸ ਲਈ ਤਰਾਜ਼ੂ ਚੁੱਪ ਰਹਿੰਦਾ ਹੈ।", vBalW: "ਬਰਾਬਰ।",
    vSur: "{b} ਅਤਿ ਹਾਲਤ ਵਿੱਚ ਵੀ ਜਿੰਨਾ ਗਿਆ ਉਸ ਤੋਂ ਵੱਧ ਵਾਪਸ ਆਇਆ।", vSurW: "ਅਸਲੀ ਵਾਧਾ।",
    vGap: "{b} ਅਤਿ ਹਾਲਤ ਵਿੱਚ ਵੀ ਇਹ ਛੋਟ ਤੋਂ ਬਾਹਰ ਹੈ।", vGapW: "ਅਸਲੀ ਫ਼ਰਕ।",
    zero: "0 = ਪੂਰਾ ਬਰਾਬਰ", allowBand: "ਮਨਜ਼ੂਰ ਛੀਜਤ", noAllow: "ਕੋਈ ਛੀਜਤ ਤੈਅ ਨਹੀਂ", gapNoise: "ਫ਼ਰਕ, ਤੱਕੜੀ ਦੀ ਚੂਕ ਸਮੇਤ",
    n4t: "ਝੂਠੀ ਚੇਤਾਵਨੀ ਨਹੀਂ", n4: "ਜੇ ਸਿਫ਼ਰ ਜਾਂ ਛੋਟ ਦਾਇਰੇ ਵਿੱਚ ਆਉਂਦੀ ਹੈ ਤਾਂ ਫ਼ਰਕ ਸਿਰਫ਼ ਚੂਕ ਹੋ ਸਕਦਾ ਹੈ, ਅਤੇ ਉਸ 'ਤੇ ਇਮਾਨਦਾਰ ਕਾਰੀਗਰ 'ਤੇ ਸ਼ੱਕ ਕਰਨਾ ਭਰੋਸਾ ਤੋੜਦਾ ਹੈ। ਤਰਾਜ਼ੂ ਉਦੋਂ ਹੀ ਬੋਲਦਾ ਹੈ ਜਦੋਂ ਪੂਰਾ ਦਾਇਰਾ ਸਾਫ਼ ਹੋਵੇ।",
    nothing: "ਸਮਝਾਉਣ ਲਈ ਕੁਝ ਨਹੀਂ।", nothingD: "ਫ਼ਰਕ ਮਾਪ ਦੀ ਚੂਕ ਅਤੇ ਤੈਅ ਛੀਜਤ ਦੇ ਅੰਦਰ ਹੈ।",
    n5bt: "ਚੁੱਪ ਰਹਿਣਾ ਵੀ ਇੱਕ ਨਤੀਜਾ ਹੈ", n5b: "ਜ਼ਿਆਦਾਤਰ ਕੰਮ ਇੱਥੇ ਹੀ ਮੁੱਕਦੇ ਹਨ। ਬਿਨਾਂ ਸਮਝਾਏ ਫ਼ਰਕ ਦੇਖਣ ਲਈ ਟ੍ਰੇ 'ਤੇ “ਉਦਾਹਰਣ” ਚੁਣੋ।",
    tried: "{n} ਸੰਭਵ ਸੁਧਾਰ ਅਜ਼ਮਾਏ · {k} ਅੰਕਾਂ ਨਾਲ ਪੂਰੀ ਤਰ੍ਹਾਂ ਮੇਲ ਖਾਂਦੇ ਹਨ:", more: "…ਅਤੇ {n} ਘੱਟ ਸੰਭਾਵੀ। “ਛੀਜਤ ਤੋਂ ਵੱਧ ਨੁਕਸਾਨ” ਉਦੋਂ ਹੀ ਦਿਖਾਇਆ ਜਾਂਦਾ ਹੈ ਜਦੋਂ ਇਹ ਸਾਰੇ ਰੱਦ ਹੋ ਜਾਣ।",
    n5t: "ਹਰ ਸਤਰ ਇੱਕ ਛੋਟਾ, ਪੱਕਾ ਸੁਧਾਰ ਹੈ", n5: "ਹਰ ਇੱਕ ਫ਼ਰਕ ਨੂੰ ਠੀਕ-ਠੀਕ ਬੰਦ ਕਰ ਦੇਵੇਗਾ। ਭੌਤਿਕ ਤੌਰ 'ਤੇ ਅਸੰਭਵ ਸੁਧਾਰ ਹਟਾ ਦਿੱਤੇ ਜਾਂਦੇ ਹਨ। ਪ੍ਰਤੀਸ਼ਤ ਇੰਜਣ ਦਾ ਸਾਪੇਖ ਭਾਰ ਹੈ, ਜੋ ਸਰਲ ਕਾਰਨਾਂ ਨੂੰ ਤਰਜੀਹ ਦਿੰਦਾ ਹੈ; ਇਹ ਸੰਭਾਵਨਾ ਨਹੀਂ।",
    noCheck: "ਕੋਈ ਜਾਂਚ ਨਹੀਂ ਚਾਹੀਦੀ।", n6zt: "ਸਿਫ਼ਰ ਮਿੰਟ", n6z: "ਜਦੋਂ ਹਿਸਾਬ ਪਹਿਲਾਂ ਹੀ ਬਰਾਬਰ ਹੈ ਤਾਂ ਕਿਸੇ ਨੂੰ ਮੁੜ ਗਿਣਨਾ ਨਹੀਂ ਪੈਂਦਾ।",
    ruled: "{n} ਰੱਦ", settled: "ਸੁਲਝਿਆ:", unres: "ਨਹੀਂ ਸੁਲਝਿਆ।", unresD: "ਕੋਈ ਕਿਫ਼ਾਇਤੀ ਜਾਂਚ ਬਾਕੀ ਕਾਰਨਾਂ ਨੂੰ ਵੱਖ ਨਹੀਂ ਕਰ ਸਕਦੀ, ਇਸ ਲਈ ਤਰਾਜ਼ੂ ਅੰਦਾਜ਼ਾ ਲਾਉਣ ਦੀ ਬਜਾਏ ਇਹੀ ਦੱਸਦਾ ਹੈ।",
    unexp: "ਕੋਈ ਸੂਚੀਬੱਧ ਕਾਰਨ ਮੇਲ ਨਹੀਂ ਖਾਂਦਾ।", unexpD: "ਪੂਰੀ ਮੁੜ ਗਿਣਤੀ ਦਾ ਸਮਾਂ ਹੈ।", confirmWith: "ਪੁਸ਼ਟੀ ਕਰੋ:", askNext: "ਅਗਲੀ ਜਾਂਚ:", cost: "{m} ਮਿੰਟ · {b} ਬਿਟ ਸ਼ੱਕ ਦੂਰ ਕਰਦੀ ਹੈ",
    thAll: "ਸਾਰੀਆਂ ਜਾਂਚਾਂ, ਕ੍ਰਮ ਵਿੱਚ", thMin: "ਮਿੰਟ", thGain: "ਪ੍ਰਤੀ ਮਿਹਨਤ ਸ਼ੱਕ ਕਿੰਨਾ ਘਟਿਆ", yourTurn: "← ਤੁਹਾਡੀ ਵਾਰੀ: ਜਾਂਚ ਵਿੱਚ ਜੋ ਮਿਲਿਆ ਉਹ ਚੁਣੋ", again: "↺ ਜਾਂਚ ਮੁੜ ਸ਼ੁਰੂ ਕਰੋ",
    n6t: "ਹਰ ਮਿੰਟ ਵਿੱਚ ਸਭ ਤੋਂ ਵੱਧ ਜਾਣਕਾਰੀ", n6: "ਤਰਾਜ਼ੂ ਉਹ ਜਾਂਚ ਚੁਣਦਾ ਹੈ ਜੋ ਪ੍ਰਤੀ ਮਿੰਟ ਸਭ ਤੋਂ ਵੱਧ ਸ਼ੱਕ ਦੂਰ ਕਰੇ, ਅਤੇ ਇੱਕ ਕਾਰਨ ਸਾਫ਼ ਹੁੰਦੇ ਹੀ ਰੁਕ ਜਾਂਦਾ ਹੈ। ਮਿਹਨਤ ਵਿੱਚ ਮਿੰਟ ਅਤੇ ਰਿਸ਼ਤੇ 'ਤੇ ਪੈਣ ਵਾਲਾ ਅਸਰ ਦੋਵੇਂ ਗਿਣੇ ਜਾਂਦੇ ਹਨ।",
    readAloud: "🔊 ਪੜ੍ਹ ਕੇ ਸੁਣਾਓ", nextWb: "ਅੱਗੇ ਵਰਕਬੈਂਚ ਵਿੱਚ: ਸੁਧਾਰ ਨਵੀਂ ਐਂਟਰੀ ਵਜੋਂ ਜੁੜਦਾ ਹੈ, ਪੁਰਾਣੀ ਕਦੇ ਨਹੀਂ ਬਦਲਦੀ, ਅਤੇ ਦੋਵੇਂ ਧਿਰਾਂ ਦੀ ਮਨਜ਼ੂਰੀ ਤੱਕ ਹਿਸਾਬ ਖਰੜਾ ਰਹਿੰਦਾ ਹੈ।",
    n7t: "ਕਦੇ “ਗੁੰਮ”, “ਖੋਇਆ” ਜਾਂ “ਚੋਰੀ” ਨਹੀਂ", n7: "ਸਿਰਫ਼ “ਹਿਸਾਬ ਨਹੀਂ ਮਿਲ ਰਿਹਾ”, ਪੰਜਾਬੀ, ਹਿੰਦੀ ਅਤੇ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ। ਆਵਾਜ਼ ਇਹੀ ਵਾਕ, ਇਹੀ ਅੰਕ ਪੜ੍ਹਦੀ ਹੈ।",
    offline: "ਇੰਜਣ ਨਹੀਂ ਚੱਲ ਰਿਹਾ। python run.py ਨਾਲ ਸ਼ੁਰੂ ਕਰੋ ਅਤੇ ਪੰਨਾ ਮੁੜ ਖੋਲ੍ਹੋ।", needIssue: "ਸ਼ੁਰੂ ਕਰਨ ਲਈ ਜਾਰੀ ਧਾਤ ਦਰਜ ਕਰੋ।",
    tray: { worked: "ਉਦਾਹਰਣ · 22 ਕੈਰਟ ਸੋਨਾ", clean: "ਸਾਫ਼ ਕੰਮ · ਚਾਂਦੀ", stone: "ਨਗ ਰਹਿ ਗਿਆ · ਚਾਂਦੀ", issue: "ਜਾਰੀ", finished: "ਗਹਿਣੇ ਵਾਪਸ", scrapF: "ਸਕ੍ਰੈਪ ਵਾਪਸ", fin: "ਸ਼ੁੱਧਤਾ", wastage: "ਮਨਜ਼ੂਰ ਛੀਜਤ", u: "ਤੱਕੜੀ ±" },
    outcome: { "extra piece found": "ਇੱਕ ਵਾਧੂ ਪੀਸ ਮਿਲਿਆ", "count matches": "ਗਿਣਤੀ ਮੇਲ ਖਾਂਦੀ ਹੈ", "unlogged scrap found": "ਬਿਨਾਂ ਦਰਜ ਸਕ੍ਰੈਪ ਮਿਲਿਆ", "nothing extra": "ਕੁਝ ਵਾਧੂ ਨਹੀਂ",
      "weight differs from entry": "ਵਜ਼ਨ ਐਂਟਰੀ ਤੋਂ ਵੱਖ ਹੈ", "weight matches entry": "ਵਜ਼ਨ ਐਂਟਰੀ ਨਾਲ ਮੇਲ ਖਾਂਦਾ ਹੈ", "item found at bench": "ਬੈਂਚ 'ਤੇ ਸਮਾਨ ਮਿਲਿਆ", "bench clear": "ਬੈਂਚ ਖ਼ਾਲੀ ਹੈ",
      "same slip and time": "ਉਹੀ ਪਰਚੀ ਤੇ ਸਮਾਂ", "distinct slips": "ਵੱਖ-ਵੱਖ ਪਰਚੀਆਂ" },
  },
};
// T("key", {vars}) fills {placeholders}; values passed in are already-escaped HTML
const D = () => TX[st.lang] || TX.en;
const T = (k, vars = {}) => String(D()[k] ?? TX.en[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => (v in vars ? vars[v] : `{${v}}`));
const outcomeLabel = o => D().outcome?.[o] || o;

const STEP_KEYS = ["job", "fine", "gap", "noise", "why", "check", "say"];
const STEP_MS = [7500, 9000, 7500, 10000, 10000, 9000, 10000];

const st = { ...SCEN.worked, scen: "worked", lang: "en", log: [], step: 0, playing: false, rep: null, autoPicked: false };
const board = $("#board");

function init() {
  // chalk roughness filter, referenced by CSS
  document.body.insertAdjacentHTML("beforeend", `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="chalkRough" x="-5%" y="-20%" width="110%" height="140%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.2"/></filter></svg>`);

  drawStepButtons();
  $("#dPrev").addEventListener("click", () => { pause(); go(Math.max(0, st.step - 1)); });
  $("#dNext").addEventListener("click", () => { pause(); go(Math.min(STEP_KEYS.length - 1, st.step + 1)); });
  $("#dPlay").addEventListener("click", () => (st.playing ? pause() : play()));
  board.addEventListener("keydown", e => { if (e.key === "ArrowRight") $("#dNext").click(); if (e.key === "ArrowLeft") $("#dPrev").click(); });
  board.tabIndex = 0;

  $$("[data-scen]").forEach(b => b.addEventListener("click", () => {
    Object.assign(st, SCEN[b.dataset.scen], { scen: b.dataset.scen, log: [], autoPicked: false });
    $$("[data-scen]").forEach(x => x.classList.toggle("on", x === b));
    syncTray(); recompute({ restart: true });
  }));
  $$("#tray [data-k]").forEach(inp => inp.addEventListener("change", () => {
    const k = inp.dataset.k;
    st[k] = k === "fin" ? inp.value : Math.max(0, +inp.value || 0);
    st.log = []; st.autoPicked = false;
    $$("[data-scen]").forEach(x => x.classList.remove("on"));
    pause(); recompute();
  }));
  $$("[data-blang]").forEach(b => b.addEventListener("click", () => setLang(b.dataset.blang)));
  syncTray();
  applyTray();

  // start playing the first time the board scrolls into view
  const io = new IntersectionObserver(es => {
    if (es.some(e => e.isIntersecting)) { io.disconnect(); if (!reduced) play(); }
  }, { threshold: 0.35 });
  io.observe(board);
  recompute({ restart: true, quiet: true });
}

function setLang(lang) {
  st.lang = TX[lang] ? lang : "en";
  $$("[data-blang]").forEach(x => { x.classList.toggle("on", x.dataset.blang === st.lang); x.setAttribute("aria-pressed", String(x.dataset.blang === st.lang)); });
  board.setAttribute("lang", st.lang);
  $("#tray").setAttribute("lang", st.lang);
  drawStepButtons();
  applyTray();
  recompute();   // the engine's own sentences (titles, checks, narration) come back in the new language
}

function drawStepButtons() {
  const d = D();
  $("#dSteps").innerHTML = STEP_KEYS.map((_, i) => `<li><button type="button" data-step="${i}" class="${i === st.step ? "on" : i < st.step ? "done" : ""}">${i + 1}<span> · ${esc(d.shorts[i])}</span></button></li>`).join("");
  $$("#dSteps button").forEach(b => b.addEventListener("click", () => { pause(); go(+b.dataset.step); }));
}
function applyTray() {
  const t = D().tray;
  $$("[data-scen]").forEach(b => { if (t[b.dataset.scen]) b.textContent = t[b.dataset.scen]; });
  const map = { issue: "issue", finished: "finished", scrap: "scrapF", fin: "fin", wastage: "wastage", u: "u" };
  $$("#tray [data-k]").forEach(inp => {
    const lab = inp.closest("label"); if (!lab) return;
    let span = lab.querySelector(".tray-lbl");
    if (!span) { span = document.createElement("span"); span.className = "tray-lbl"; [...lab.childNodes].forEach(n => { if (n.nodeType === 3 && n.textContent.trim()) n.remove(); }); lab.prepend(span); }
    span.textContent = t[map[inp.dataset.k]] || "";
  });
}

function syncTray() {
  $$("#tray [data-k]").forEach(inp => { inp.value = st[inp.dataset.k]; });
}

/* ------------------------------------------------------------ engine */
let reqSeq = 0;
async function recompute({ restart = false, quiet = false } = {}) {
  const u = String((+st.u || 0) / 1000);
  const rows = [
    { event_type: "ISSUE", value: String(st.issue), fineness: st.fin, u_mass_g: u },
    { event_type: "RETURN_FINISHED", value: String(st.finished), fineness: st.fin, u_mass_g: u, pieces: 1 },
    { event_type: "RETURN_SCRAP", value: String(st.scrap), fineness: st.fin, u_mass_g: u },
  ].filter(r => +r.value > 0);
  const seq = ++reqSeq;
  if (!(+st.issue > 0)) { offline(T("needIssue")); return; }
  try {
    const rep = await api("/api/quick", { method: "POST", body: {
      events: rows, metal: metalOf(st.fin), wastage_min_pct: "0", wastage_max_pct: String(st.wastage || 0),
      lang: st.lang, check_log: st.log } });
    if (seq !== reqSeq) return;
    st.rep = rep;
    $("#rawPre").textContent = JSON.stringify(rep, null, 2);
    render(restart ? 0 : st.step, { instant: quiet });
  } catch (e) {
    offline(e.status === 0 ? T("offline") : e.message);
  }
}
function offline(msg) {
  $("#boardBody").innerHTML = `<span class="cl crd" style="--k:0">${esc(msg)}</span>`;
  $("#boardNote").innerHTML = "";
}

/* ------------------------------------------------------------ playback */
let timer = null, progT0 = 0, progMs = 0, progRaf = 0;
function play() {
  st.playing = true; $("#dPlay").textContent = "❚❚"; $("#dPlay").setAttribute("aria-label", "Pause");
  if (st.step === STEP_KEYS.length - 1) { st.log = []; st.autoPicked = false; recompute({ restart: true }); return; }
  schedule();
}
function pause() {
  st.playing = false; $("#dPlay").textContent = "▶"; $("#dPlay").setAttribute("aria-label", "Play");
  clearTimeout(timer); cancelAnimationFrame(progRaf); $("#dProg").style.width = "0";
}
function schedule() {
  clearTimeout(timer); cancelAnimationFrame(progRaf);
  if (!st.playing) return;
  progMs = STEP_MS[st.step]; progT0 = performance.now();
  const tick = () => {
    $("#dProg").style.width = `${Math.min(100, (performance.now() - progT0) / progMs * 100)}%`;
    if (st.playing) progRaf = requestAnimationFrame(tick);
  };
  tick();
  timer = setTimeout(advance, progMs);
}
function advance() {
  if (!st.playing) return;
  const nc = st.rep?.investigation?.next_check;
  // on the check step, autoplay answers the check once so viewers see explanations drop out
  if (STEP_KEYS[st.step] === "check" && nc && !st.autoPicked) {
    st.autoPicked = true;
    st.log = [...st.log, { check_id: nc.check_id, outcome: nc.outcomes[0] }];
    recompute().then(schedule);
    return;
  }
  if (st.step >= STEP_KEYS.length - 1) { pause(); return; }
  go(st.step + 1, { keepPlaying: true });
}
function go(i, { keepPlaying = false } = {}) {
  if (!st.rep) return;
  board.classList.add("wiping");
  setTimeout(() => { board.classList.remove("wiping"); render(i); if (keepPlaying) schedule(); }, reduced ? 0 : 320);
}

/* ------------------------------------------------------------ rendering */
function render(i, { instant = false } = {}) {
  st.step = i;
  const key = STEP_KEYS[i], rep = st.rep, d = D();
  board.classList.toggle("instant", instant || reduced);
  $("#boardStep").textContent = T("stepOf", { i: i + 1, n: STEP_KEYS.length });
  $("#boardTitle").textContent = d.steps[i];
  $$("#dSteps button").forEach((b, j) => { b.classList.toggle("on", j === i); b.classList.toggle("done", j < i); });
  const { body, note, lines } = VIEWS[key](rep);
  $("#boardBody").innerHTML = body;
  $("#boardNote").innerHTML = note;
  $("#boardNote").style.setProperty("--nd", instant || reduced ? "0s" : `${Math.min(lines, 7) * .55 + .4}s`);
  // restart the note animation
  const n = $("#boardNote"); n.style.animation = "none"; void n.offsetWidth; n.style.animation = "";
  $("#boardFoot").innerHTML = `<span><i class="live"></i>${esc(T("foot", { ms: rep.latency_ms }))}</span>
    <span>· ${esc(T("solver"))}: ${esc(rep.explain?.solver || "–")}</span><span>· ${esc(T("saved"))}</span>`;
  wire(key);
}

// helper: numbered chalk lines
function lineMaker() {
  let k = 0;
  const L = (html, cls = "") => `<span class="cl ${cls}" style="--k:${k++}">${html}</span>`;
  L.count = () => k;
  L.next = () => k++;
  return L;
}
const note = (t, body, arrow = "↖") => `<span class="arrow">${arrow}</span><b>${esc(T(t))}</b>${esc(T(body))}`;
const gs = (x, cls = "cg") => `<span class="${cls}">${g3(x)} g</span>`;

const VIEWS = {
  job() {
    const L = lineMaker(), d = D();
    const name = d.fin[st.fin] || `${st.fin}`;
    const body = [
      L(T("give", { g: `<span class="cg big">${g3(st.issue)} g</span>`, name: esc(name) })),
      L(`<span class="cdim">${T("purity", { fin: esc(st.fin), metal: esc(d.metal[metalOf(st.fin)]) })}</span>`),
      `<div class="gap"></div>`,
      L(esc(T("brings"))),
      L(`&nbsp;&nbsp;• ${esc(T("jewellery"))} &nbsp;${gs(st.finished)}`),
      L(`&nbsp;&nbsp;• ${esc(T("scrap"))} &nbsp;${gs(st.scrap)}`),
      `<div class="gap"></div>`,
      L(`${T("agreed", { w: `<span class="cg">${+st.wastage || 0}%</span>` })} &nbsp;·&nbsp; ${T("scaleAcc", { u: `<span class="cg">± ${+st.u || 0} mg</span>` })}`),
    ].join("");
    return { body, lines: L.count(), note: note("n1t", "n1", "↙") };
  },

  fine(rep) {
    const L = lineMaker();
    const TYPE = { ISSUE: T("tIssue"), RETURN_FINISHED: T("tFin"), RETURN_SCRAP: T("tScrap") };
    const ins = rep.events.filter(e => e.event_type === "ISSUE");
    const outs = rep.events.filter(e => e.event_type !== "ISSUE");
    const row = e => L(`<span class="eq">${esc(TYPE[e.event_type] || e.label)}: &nbsp;${g3(e.effective.mass_g)} × ${esc(e.effective.fineness)} = <b class="cg">${g3(e.effective.fine_g)} g</b></span>`);
    const b = rep.balance;
    const body = [
      L(`<span class="big">F = m × φ</span> <span class="cdim">&nbsp; ${esc(T("pureEq"))}</span>`),
      `<div class="gap"></div>`,
      L(`<span class="cdim">${esc(T("out"))}</span>`), ...ins.map(row),
      L(`<span class="cdim">${esc(T("back"))}</span>`), ...outs.map(row),
      +b.fine_deduct_g ? L(T("deduct", { g: `${g3(b.fine_deduct_g)} g` })) : "",
      `<div class="gap"></div>`,
      L(T("pureOut", { a: `<span class="cg box">${g3(b.fine_in_g)} g</span> &nbsp;&nbsp;`, b: `<span class="cg box">${g3(b.fine_out_g)} g</span>` })),
    ].join("");
    return { body, lines: L.count(), note: note("n2t", "n2") };
  },

  gap(rep) {
    const L = lineMaker(), b = rep.balance;
    const raw = +b.raw_g, band = +b.band_hi_g;
    const lines = [
      L(`<span class="eq">${g3(b.fine_in_g)} − ${g3(b.fine_out_g)} = <b class="cg big">${g3(raw)} g</b> ${esc(T("pure"))}</span>`),
      L(`<span class="cdim">${esc(raw >= 0 ? T("notBack") : T("moreBack"))}</span>`),
      `<div class="gap"></div>`,
      L(T("allowed", { g: gs(band), w: +st.wastage || 0, f: `${g3(b.fine_in_g)} g` })),
    ];
    if (b.verdict === "unaccounted") lines.push(L(T("beyond", { g: `<span class="cg big ul">${g3(b.excess_g)} g</span>` })));
    else if (b.verdict === "surplus") lines.push(L(T("surplus", { g: `<span class="cbl big ul">${g3(Math.abs(+b.excess_g))} g</span>` })));
    else lines.push(L(`<span class="cgr">${esc(T("fits"))}</span>`));
    return { body: lines.join(""), lines: L.count(), note: note("n3t", "n3") };
  },

  noise(rep) {
    const L = lineMaker(), b = rep.balance;
    const svg = gapDiagram(b, L);
    const lo = +b.residual_lo_g + +b.band_hi_g, hi = +b.residual_hi_g + +b.band_lo_g;
    const verdictLine = b.verdict === "balanced"
      ? L(T("vBal", { b: `<span class="cgr big">${esc(T("vBalW"))}</span>` }))
      : b.verdict === "surplus"
        ? L(T("vSur", { b: `<span class="cbl big">${esc(T("vSurW"))}</span>` }))
        : L(T("vGap", { b: `<span class="cg big">${esc(T("vGapW"))}</span>` }));
    const body = [
      L(esc(T("range", { u: +st.u || 0 }))),
      L(`<span class="eq">${T("inRange", { r: `<b class="cg">[ ${g3(lo)} , ${g3(hi)} ] g</b>` })}</span>`),
      svg,
      verdictLine,
    ].join("");
    return { body, lines: L.count(), note: note("n4t", "n4") };
  },

  why(rep) {
    const L = lineMaker(), b = rep.balance;
    if (b.verdict === "balanced") {
      return { body: L(`<span class="cgr big">${esc(T("nothing"))}</span>`) + L(esc(T("nothingD"))), lines: 2, note: note("n5bt", "n5b") };
    }
    const xs = rep.explanations.filter(x => !x.last_resort);
    const shown = xs.slice(0, 5);
    const ex = rep.explain || {};
    const items = shown.map((x, i) => {
      const k = L.next();
      return `<li class="cl ${x.alive ? "" : "dead"} ${i === 0 && x.alive ? "top" : ""}" style="--k:${k}">
        <span class="h">${esc(x.hyps.join("+"))}</span>
        <div><div class="t">${esc(x.titles.join(" + "))}</div><div class="d" lang="en">${esc(x.edits.map(e => e.text).join(" · "))}</div>
          <div class="bar"><i style="width:${(x.prob * 100).toFixed(1)}%;--k:${k}"></i></div></div>
        <span class="p">${x.alive ? (x.prob * 100).toFixed(0) + "%" : "✗"}</span></li>`;
    }).join("");
    const body = L(T("tried", { n: `<span class="cg">${ex.n_candidates ?? "–"}</span>`, k: `<span class="cg">${xs.filter(x => x.alive).length}</span>` })) +
      `<ol class="xl">${items}</ol>` +
      (xs.length > shown.length ? L(`<span class="cdim">${esc(T("more", { n: xs.length - shown.length }))}</span>`) : "");
    return { body, lines: L.count(), note: note("n5t", "n5") };
  },

  check(rep) {
    const L = lineMaker(), b = rep.balance, inv = rep.investigation, nc = inv.next_check;
    if (b.verdict === "balanced") return { body: L(`<span class="cgr big">${esc(T("noCheck"))}</span>`), lines: 1, note: note("n6zt", "n6z") };
    const parts = [];
    inv.log.forEach(l => parts.push(L(`✓ ${esc(l.text)}: <span class="cg">${esc(outcomeLabel(l.outcome))}</span> <span class="cdim">(${esc(T("ruled", { n: l.eliminated }))})</span>`)));
    const best = rep.explanations.find(x => x.key === inv.best);
    if (inv.status === "resolved" && !nc?.confirm) parts.push(L(`<span class="cgr big">${esc(T("settled"))}</span> ${esc(best ? best.titles.join(" + ") : inv.best)}`));
    else if (inv.status === "abstain") parts.push(L(`<span class="cg big">${esc(T("unres"))}</span> ${esc(T("unresD"))}`));
    else if (inv.status === "unexplained") parts.push(L(`<span class="crd big">${esc(T("unexp"))}</span> ${esc(T("unexpD"))}`));
    if (nc) {
      parts.push(L(`${esc(nc.confirm ? T("confirmWith") : T("askNext"))} <span class="cg big">${esc(nc.text)}</span>`));
      parts.push(L(`<span class="cdim">${esc(T("cost", { m: nc.minutes, b: nc.gain_bits }))}</span>`));
      const ranked = (inv.ranked || []).slice(0, 4);
      if (ranked.length > 1 && !inv.log.length) {
        const k = L.next();
        const maxg = Math.max(...ranked.map(r => r.gain_per_cost), 1e-9);
        parts.push(`<table class="ctable cl" style="--k:${k}"><tr><th>${esc(T("thAll"))}</th><th class="n">${esc(T("thMin"))}</th><th class="n">${esc(T("thGain"))}</th></tr>${ranked.map((r, j) =>
          `<tr class="${j === 0 ? "best" : ""}"><td>${esc(r.text)}</td><td class="n">${r.minutes}</td><td class="n">${"▮".repeat(Math.max(1, Math.round(r.gain_per_cost / maxg * 8)))}</td></tr>`).join("")}</table>`);
      }
      const k = L.next();
      parts.push(`<div class="cl" style="--k:${k}"><div class="outs">${nc.outcomes.map(o => `<button type="button" class="out-btn" data-o="${esc(o)}">${esc(outcomeLabel(o))}</button>`).join("")}</div>
        <span class="your-turn">${esc(T("yourTurn"))}</span></div>`);
    }
    if (inv.log.length) parts.push(L(`<a href="#" class="cdim" data-reset>${esc(T("again"))}</a>`));
    return { body: parts.join(""), lines: L.count(), note: note("n6t", "n6") };
  },

  say(rep) {
    const L = lineMaker();
    const lines = rep.narration.map(s => L(`“${hl(esc(s))}”`)).join("");
    return { body: lines + `<div class="gap"></div>` +
      L(`<button type="button" class="out-btn" id="sayBtn">${esc(T("readAloud"))}</button> <span class="cdim" id="sayNote"></span>`) +
      L(`<span class="cdim">${esc(T("nextWb"))}</span>`),
      lines: L.count(), note: note("n7t", "n7") };
  },
};

function hl(s) {
  return s.replace(/(unaccounted for|unaccounted|हिसाब नहीं मिल रहा|ਹਿਸਾਬ ਨਹੀਂ ਮਿਲ ਰਿਹਾ)/gi, `<span class="ul">$1</span>`);
}

/* chalk number line: zero, allowance band and the gap interval */
function gapDiagram(b, L) {
  const W = 640, H = 150, y = 70, Lx = 30, Rx = W - 30;
  const bandLo = +b.band_lo_g, bandHi = +b.band_hi_g;
  const lo = +b.residual_lo_g + bandHi, hi = +b.residual_hi_g + bandLo, raw = +b.raw_g;
  let a = Math.min(0, lo, bandLo), z = Math.max(0, hi, bandHi);
  let span = z - a; if (span < .01) { a -= .005; z += .005; span = z - a; }
  a -= span * .2; z += span * .2;
  const X = v => Lx + (v - a) / (z - a) * (Rx - Lx);
  const k1 = L.next(), k2 = L.next();
  const col = b.verdict === "balanced" ? "#a9e2b6" : b.verdict === "surplus" ? "#a6cdf2" : "#f4d06f";
  let ix = X(lo), iw = X(hi) - X(lo); if (iw < 12) { ix -= (12 - iw) / 2; iw = 12; }
  const bw = Math.max(X(bandHi) - X(bandLo), 3);
  return `<svg class="chalk-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(T("inRange", { r: `[${g3(lo)}, ${g3(hi)}] g` }))}">
    <line class="chalk-draw" pathLength="1" style="--k:${k1}" x1="${Lx}" y1="${y}" x2="${Rx}" y2="${y}" stroke="#f3f0e6" stroke-width="2.4" stroke-linecap="round"/>
    <line class="chalk-draw" pathLength="1" style="--k:${k1}" x1="${X(0)}" y1="${y - 40}" x2="${X(0)}" y2="${y + 30}" stroke="#f3f0e6" stroke-width="2" stroke-dasharray="1" stroke-linecap="round"/>
    <text class="chalk-fade" style="--k:${k1}" x="${X(0)}" y="${y - 46}" text-anchor="middle" font-size="15">${esc(T("zero"))}</text>
    <rect class="chalk-draw" pathLength="1" style="--k:${k1}" x="${X(bandLo)}" y="${y - 20}" width="${bw}" height="40" rx="8" fill="none" stroke="#a9e2b6" stroke-width="2"/>
    <text class="chalk-fade" style="--k:${k1}" x="${X(bandLo) + bw / 2}" y="${y + 50}" text-anchor="middle" font-size="14" fill="#a9e2b6">${esc(bandHi > bandLo ? T("allowBand") : T("noAllow"))}</text>
    <rect class="chalk-draw" pathLength="1" style="--k:${k2}" x="${ix}" y="${y - 9}" width="${iw}" height="18" rx="9" fill="none" stroke="${col}" stroke-width="3"/>
    <rect class="chalk-fade" style="--k:${k2}" x="${ix}" y="${y - 9}" width="${iw}" height="18" rx="9" fill="${col}" opacity=".35"/>
    <circle class="chalk-fade" style="--k:${k2}" cx="${X(raw)}" cy="${y}" r="3.5" fill="#f3f0e6"/>
    <text class="chalk-fade" style="--k:${k2}" x="${Math.min(Math.max(ix + iw / 2, 90), W - 90)}" y="${y + 50 + (Math.abs(ix + iw / 2 - (X(bandLo) + bw / 2)) < 130 ? 22 : 0)}" text-anchor="middle" font-size="15" fill="${col}">${esc(T("gapNoise"))}</text>
  </svg>`;
}

/* interactive bits inside the board */
function wire(key) {
  if (key === "check") {
    const nc = st.rep.investigation.next_check;
    $$("#boardBody [data-o]").forEach(btn => btn.addEventListener("click", () => {
      pause();
      st.autoPicked = true;
      st.log = [...st.log, { check_id: nc.check_id, outcome: btn.dataset.o }];
      recompute();
    }));
    $("#boardBody [data-reset]")?.addEventListener("click", e => { e.preventDefault(); pause(); st.log = []; st.autoPicked = false; recompute(); });
  }
  if (key === "say") {
    $("#sayBtn")?.addEventListener("click", async () => {
      pause();
      const r = await speak(st.rep.narration, st.lang);
      $("#sayNote").textContent = r.note || "";
    });
  }
}

if (board) init();
