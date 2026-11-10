"""Non-accusing narration in English, Hindi and Punjabi (protocol 4.3, 12.1).

The output says "unaccounted for", never "missing", "lost" or "stolen".
Numbers come from the decimal engine and are formatted identically for the
screen and the voice readback.
"""
from __future__ import annotations

from decimal import Decimal

from .units import fmt_g

FORBIDDEN = ["missing", "lost", "stolen", "theft", "thief", "steal", "चोरी", "चोर", "ਚੋਰੀ", "ਚੋਰ", "गायब", "ਗਾਇਬ"]

METAL = {
    "en": {"silver": "silver", "gold": "gold", "brass": "metal", "copper": "metal"},
    "hi": {"silver": "चाँदी", "gold": "सोना", "brass": "धातु", "copper": "धातु"},
    "pa": {"silver": "ਚਾਂਦੀ", "gold": "ਸੋਨਾ", "brass": "ਧਾਤ", "copper": "ਧਾਤ"},
}

HYP_TEXT = {
    "en": {
        "H1": "A finished piece came back but was not logged",
        "H2": "Scrap or sweepings were not logged",
        "H3": "Metal is still in work-in-progress at the bench",
        "H4": "A return has a different fineness than written",
        "H5": "A weight was misread or a scale drifted",
        "H6": "A unit or transcription error on a slip",
        "H7": "A slip was entered twice",
        "H8": "Stones or fixtures were not deducted",
        "H9": "Process loss exceeded the agreed wastage (last resort)",
    },
    "hi": {
        "H1": "एक तैयार पीस लौटाया गया पर दर्ज नहीं हुआ",
        "H2": "स्क्रैप या झाड़न दर्ज नहीं हुई",
        "H3": "धातु अभी कारीगर की बेंच पर काम में है",
        "H4": "किसी वापसी की शुद्धता पर्ची पर लिखी शुद्धता से अलग है",
        "H5": "कोई वज़न गलत पढ़ा गया या तराज़ू खिसका",
        "H6": "पर्ची पर इकाई या लिखावट की गलती",
        "H7": "एक पर्ची दो बार दर्ज हुई",
        "H8": "नग या फ़िटिंग का वज़न नहीं घटाया गया",
        "H9": "काम की घटत तय छीजत से ज़्यादा रही (आख़िरी विकल्प)",
    },
    "pa": {
        "H1": "ਇੱਕ ਤਿਆਰ ਪੀਸ ਵਾਪਸ ਆਇਆ ਪਰ ਦਰਜ ਨਹੀਂ ਹੋਇਆ",
        "H2": "ਸਕ੍ਰੈਪ ਜਾਂ ਝਾੜਨ ਦਰਜ ਨਹੀਂ ਹੋਈ",
        "H3": "ਧਾਤ ਅਜੇ ਕਾਰੀਗਰ ਦੇ ਬੈਂਚ 'ਤੇ ਕੰਮ ਵਿੱਚ ਹੈ",
        "H4": "ਕਿਸੇ ਵਾਪਸੀ ਦੀ ਸ਼ੁੱਧਤਾ ਪਰਚੀ 'ਤੇ ਲਿਖੀ ਤੋਂ ਵੱਖਰੀ ਹੈ",
        "H5": "ਕੋਈ ਵਜ਼ਨ ਗਲਤ ਪੜ੍ਹਿਆ ਗਿਆ ਜਾਂ ਤੱਕੜੀ ਖਿਸਕੀ",
        "H6": "ਪਰਚੀ 'ਤੇ ਇਕਾਈ ਜਾਂ ਲਿਖਤ ਦੀ ਗਲਤੀ",
        "H7": "ਇੱਕ ਪਰਚੀ ਦੋ ਵਾਰ ਦਰਜ ਹੋਈ",
        "H8": "ਨਗ ਜਾਂ ਫਿਟਿੰਗ ਦਾ ਵਜ਼ਨ ਨਹੀਂ ਘਟਾਇਆ ਗਿਆ",
        "H9": "ਕੰਮ ਦੀ ਘਾਟ ਤੈਅ ਛੀਜਤ ਤੋਂ ਵੱਧ ਰਹੀ (ਆਖਰੀ ਵਿਕਲਪ)",
    },
}

CHECK_TEXT = {
    "en": {
        "count_pieces": "Count finished pieces against the order sheet",
        "weigh_scrap_bag": "Weigh the scrap and sweepings bag",
        "weigh_bench": "Weigh any item still at the karigar's bench",
        "assay": "Assay the fineness of {ev}",
        "reweigh": "Reweigh {ev} on the second scale with a check weight",
        "photo": "Compare the slip photo of {ev} with the entry",
        "dup_match": "Match timestamps and photos of {ev} with the entry it repeats",
        "weigh_stones": "Weigh stones and findings in {ev}",
    },
    "hi": {
        "count_pieces": "ऑर्डर शीट से तैयार पीस गिनें",
        "weigh_scrap_bag": "स्क्रैप और झाड़न की थैली तौलें",
        "weigh_bench": "कारीगर की बेंच पर रखा सामान तौलें",
        "assay": "{ev} की शुद्धता जाँचें (एसे)",
        "reweigh": "{ev} को दूसरे तराज़ू पर जाँच-बाट के साथ दोबारा तौलें",
        "photo": "{ev} की पर्ची की फ़ोटो को एंट्री से मिलाएँ",
        "dup_match": "{ev} और उससे मिलती एंट्री का समय और फ़ोटो मिलाएँ",
        "weigh_stones": "{ev} में लगे नग और फ़िटिंग तौलें",
    },
    "pa": {
        "count_pieces": "ਆਰਡਰ ਸ਼ੀਟ ਨਾਲ ਤਿਆਰ ਪੀਸ ਗਿਣੋ",
        "weigh_scrap_bag": "ਸਕ੍ਰੈਪ ਅਤੇ ਝਾੜਨ ਦੀ ਥੈਲੀ ਤੋਲੋ",
        "weigh_bench": "ਕਾਰੀਗਰ ਦੇ ਬੈਂਚ 'ਤੇ ਪਿਆ ਸਮਾਨ ਤੋਲੋ",
        "assay": "{ev} ਦੀ ਸ਼ੁੱਧਤਾ ਜਾਂਚੋ (ਐਸੇ)",
        "reweigh": "{ev} ਨੂੰ ਦੂਜੀ ਤੱਕੜੀ 'ਤੇ ਜਾਂਚ-ਵੱਟੇ ਨਾਲ ਦੁਬਾਰਾ ਤੋਲੋ",
        "photo": "{ev} ਦੀ ਪਰਚੀ ਦੀ ਫੋਟੋ ਨੂੰ ਐਂਟਰੀ ਨਾਲ ਮਿਲਾਓ",
        "dup_match": "{ev} ਅਤੇ ਉਸ ਨਾਲ ਮਿਲਦੀ ਐਂਟਰੀ ਦਾ ਸਮਾਂ ਅਤੇ ਫੋਟੋ ਮਿਲਾਓ",
        "weigh_stones": "{ev} ਵਿੱਚ ਲੱਗੇ ਨਗ ਅਤੇ ਫਿਟਿੰਗ ਤੋਲੋ",
    },
}

SENTENCES = {
    "en": {
        "balanced": "The balance closes within measurement uncertainty and the agreed wastage. Nothing to explain.",
        "unaccounted": "{x} g fine {metal} is unaccounted for, beyond the agreed wastage.",
        "surplus": "{x} g more fine {metal} is recorded as returned than was issued.",
        "interval": "Taking scale and fineness uncertainty into account, the gap lies between {lo} g and {hi} g.",
        "n_expl": "{n} physically possible explanations fit.",
        "top": "Most likely so far: {h} ({p}%).",
        "next": "Cheapest next check: {c}.",
        "resolved": "Resolved: {h}. Both sides should confirm before any correction is added.",
        "abstain": "Unresolved. These explanations still fit and no affordable check separates them: {list}.",
        "unexplained": "No listed explanation fits what was observed. Please review the slips together.",
    },
    "hi": {
        "balanced": "हिसाब नाप की अनिश्चितता और तय छीजत के भीतर मिल गया है। समझाने को कुछ नहीं।",
        "unaccounted": "तय छीजत के बाद {x} ग्राम शुद्ध {metal} का हिसाब नहीं मिल रहा है।",
        "surplus": "जारी की गई धातु से {x} ग्राम शुद्ध {metal} ज़्यादा वापस दर्ज है।",
        "interval": "तराज़ू और शुद्धता की अनिश्चितता जोड़कर यह अंतर {lo} ग्राम से {hi} ग्राम के बीच है।",
        "n_expl": "{n} संभावित कारण इस अंतर से मेल खाते हैं।",
        "top": "अभी सबसे संभावित: {h} ({p}%)।",
        "next": "अगली सबसे सस्ती जाँच: {c}।",
        "resolved": "सुलझ गया: {h}। सुधार जोड़ने से पहले दोनों पक्ष पुष्टि करें।",
        "abstain": "अभी नहीं सुलझा। ये कारण अब भी मेल खाते हैं और कोई सस्ती जाँच इन्हें अलग नहीं करती: {list}।",
        "unexplained": "देखे गए नतीजे से कोई भी सूचीबद्ध कारण मेल नहीं खाता। कृपया पर्चियाँ साथ बैठकर देखें।",
    },
    "pa": {
        "balanced": "ਹਿਸਾਬ ਮਾਪ ਦੀ ਅਨਿਸ਼ਚਿਤਤਾ ਅਤੇ ਤੈਅ ਛੀਜਤ ਦੇ ਅੰਦਰ ਮਿਲ ਗਿਆ ਹੈ। ਸਮਝਾਉਣ ਲਈ ਕੁਝ ਨਹੀਂ।",
        "unaccounted": "ਤੈਅ ਛੀਜਤ ਤੋਂ ਬਾਅਦ {x} ਗ੍ਰਾਮ ਸ਼ੁੱਧ {metal} ਦਾ ਹਿਸਾਬ ਨਹੀਂ ਮਿਲ ਰਿਹਾ।",
        "surplus": "ਜਾਰੀ ਕੀਤੀ ਧਾਤ ਨਾਲੋਂ {x} ਗ੍ਰਾਮ ਸ਼ੁੱਧ {metal} ਵੱਧ ਵਾਪਸ ਦਰਜ ਹੈ।",
        "interval": "ਤੱਕੜੀ ਅਤੇ ਸ਼ੁੱਧਤਾ ਦੀ ਅਨਿਸ਼ਚਿਤਤਾ ਜੋੜ ਕੇ ਇਹ ਫ਼ਰਕ {lo} ਗ੍ਰਾਮ ਤੋਂ {hi} ਗ੍ਰਾਮ ਦੇ ਵਿਚਕਾਰ ਹੈ।",
        "n_expl": "{n} ਸੰਭਵ ਕਾਰਨ ਇਸ ਫ਼ਰਕ ਨਾਲ ਮੇਲ ਖਾਂਦੇ ਹਨ।",
        "top": "ਹੁਣ ਤੱਕ ਸਭ ਤੋਂ ਸੰਭਾਵਿਤ: {h} ({p}%)।",
        "next": "ਅਗਲੀ ਸਭ ਤੋਂ ਸਸਤੀ ਜਾਂਚ: {c}।",
        "resolved": "ਸੁਲਝ ਗਿਆ: {h}। ਸੁਧਾਰ ਜੋੜਨ ਤੋਂ ਪਹਿਲਾਂ ਦੋਵੇਂ ਧਿਰਾਂ ਪੁਸ਼ਟੀ ਕਰਨ।",
        "abstain": "ਅਜੇ ਨਹੀਂ ਸੁਲਝਿਆ। ਇਹ ਕਾਰਨ ਅਜੇ ਵੀ ਮੇਲ ਖਾਂਦੇ ਹਨ ਅਤੇ ਕੋਈ ਸਸਤੀ ਜਾਂਚ ਇਨ੍ਹਾਂ ਨੂੰ ਵੱਖ ਨਹੀਂ ਕਰਦੀ: {list}।",
        "unexplained": "ਵੇਖੇ ਨਤੀਜੇ ਨਾਲ ਕੋਈ ਵੀ ਦਰਜ ਕਾਰਨ ਮੇਲ ਨਹੀਂ ਖਾਂਦਾ। ਕਿਰਪਾ ਕਰਕੇ ਪਰਚੀਆਂ ਇਕੱਠੇ ਬੈਠ ਕੇ ਵੇਖੋ।",
    },
}

LANGS = ("en", "hi", "pa")

TYPE_LABEL = {
    "en": {"ISSUE": "Issue", "ALLOY_ADD": "Alloy", "RETURN_FINISHED": "Finished return",
           "RETURN_SCRAP": "Scrap return", "WIP_HOLD": "Work-in-progress", "TRANSFER": "Transfer",
           "STONE_SET": "Stones", "REWEIGH": "Reweigh", "ASSAY": "Assay", "CORRECTION": "Correction"},
    "hi": {"ISSUE": "जारी", "ALLOY_ADD": "मिलावट", "RETURN_FINISHED": "तैयार वापसी",
           "RETURN_SCRAP": "स्क्रैप वापसी", "WIP_HOLD": "काम में", "TRANSFER": "ट्रांसफ़र",
           "STONE_SET": "नग", "REWEIGH": "दोबारा तौल", "ASSAY": "एसे", "CORRECTION": "सुधार"},
    "pa": {"ISSUE": "ਜਾਰੀ", "ALLOY_ADD": "ਮਿਲਾਵਟ", "RETURN_FINISHED": "ਤਿਆਰ ਵਾਪਸੀ",
           "RETURN_SCRAP": "ਸਕ੍ਰੈਪ ਵਾਪਸੀ", "WIP_HOLD": "ਕੰਮ ਵਿੱਚ", "TRANSFER": "ਟ੍ਰਾਂਸਫਰ",
           "STONE_SET": "ਨਗ", "REWEIGH": "ਦੁਬਾਰਾ ਤੋਲ", "ASSAY": "ਐਸੇ", "CORRECTION": "ਸੁਧਾਰ"},
}


def hyp_text(h: str, lang: str = "en") -> str:
    return HYP_TEXT.get(lang, HYP_TEXT["en"]).get(h, h)


def check_text(kind: str, ev_label: str, lang: str = "en") -> str:
    return CHECK_TEXT.get(lang, CHECK_TEXT["en"])[kind].format(ev=ev_label)


def narrate(verdict: str, excess_ug: Decimal, lo_ug: Decimal, hi_ug: Decimal, metal: str,
            lang: str = "en", n_expl: int = 0, top: tuple | None = None,
            next_check: str | None = None, status: str | None = None,
            survivors: list[str] | None = None) -> list[str]:
    S = SENTENCES.get(lang, SENTENCES["en"])
    m = METAL.get(lang, METAL["en"]).get(metal, metal)
    out = []
    if verdict == "balanced":
        out.append(S["balanced"])
        return out
    x = fmt_g(abs(excess_ug))
    out.append(S[verdict].format(x=x, metal=m))
    out.append(S["interval"].format(lo=fmt_g(lo_ug), hi=fmt_g(hi_ug)))
    if n_expl:
        out.append(S["n_expl"].format(n=n_expl))
    if status == "resolved" and top:
        out.append(S["resolved"].format(h=top[0]))
    elif status == "abstain":
        out.append(S["abstain"].format(list="; ".join(survivors or [])))
    elif status == "unexplained":
        out.append(S["unexplained"])
    else:
        if top:
            out.append(S["top"].format(h=top[0], p=top[1]))
        if next_check:
            out.append(S["next"].format(c=next_check))
    return out
