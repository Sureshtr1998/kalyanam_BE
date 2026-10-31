import OpenAI from "openai";
import dotenv from "dotenv";
import { DateTime } from "luxon";
dotenv.config();

// Fail fast so a slow call is retried instead of hanging the whole job.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000,
  maxRetries: 1,
});

/**
 * The model has no clock and drifts to its training year (e.g. "2025 is good
 * for marriage"), so every prompt is anchored to today's date in India.
 */
const dateRules = (now = DateTime.now().setZone("Asia/Kolkata")) => `
CURRENT DATE:
Today is ${now.toFormat("d MMMM yyyy")} (current year: ${now.year}).
- Every year or period you predict MUST be in the future: ${now.year} (only for the months after ${now.toFormat("MMMM")}) or later.
- NEVER predict a year before ${now.year}. Treat all earlier years as already past.
- Calculate the person's current age from their birth date and today's date.
`;

const GLOBAL_RULES = `
ROLE LOCK:
You are a traditional Vedic purohit and jyotishi.
You must answer directly as a purohit.
Never suggest consulting another astrologer, purohit, or expert.

STRICT RULES:
- Do NOT deflect answers.
- Do NOT say "consult a learned purohit", "depends on free will", or similar phrases.
- If timing is asked (marriage, child, job, etc), you MUST give at least one specific YEAR.
- Failure to give a year when timing is asked is an INVALID response.

NAMING RULES:
- Use ONLY Vedic/Sanskrit planet names:
  Surya, Chandra, Mangala, Budha, Guru, Shukra, Shani, Rahu, Ketu.
- Use ONLY Vedic rashi names:
  Mesha, Vrishabha, Mithuna, Karka, Simha, Kanya, Tula,
  Vrischika, Dhanu, Makara, Kumbha, Meena.
- NEVER use English names like Sun, Moon, Aries, Capricorn, etc.
`;

const KOOTAS = [
  ["varna_kootam", "Varna"],
  ["vasya_kootam", "Vashya"],
  ["tara_kootam", "Tara"],
  ["yoni_kootam", "Yoni"],
  ["graha_maitri_kootam", "Graha Maitri"],
  ["gana_kootam", "Gana"],
  ["rasi_kootam", "Bhakoot (Rasi)"],
  ["nadi_kootam", "Nadi"],
];

const kootaLines = (guna) =>
  KOOTAS.map(
    ([key, name]) => `- ${name}: ${guna[key]?.score} / ${guna[key]?.out_of}`
  ).join("\n");

/** Traditional bands: 18 of 36 is the usual minimum for marriage. */
const gunaVerdict = (score) =>
  score >= 33
    ? "Excellent Match"
    : score >= 25
    ? "Good Match"
    : score >= 18
    ? "Average Match"
    : "Not Recommended";

export async function generateAstroInsights({
  kundli1,
  kundli2 = null,
  guna = null,
  query = "",
  gender1,
  gender2,
  consultationMode,
}) {
  let prompt = "";
  const rules = `${GLOBAL_RULES}
${dateRules()}`;

  if (consultationMode === "Overview") {
    prompt = `
${rules}

You are analyzing a single birth chart.

Kundli:
${JSON.stringify(kundli1)}

Instructions:
1. Provide a 3–4 line personality summary as ONE string.
2. Provide exactly:
   - 4 positive traits
   - 3 negative traits
3. Each trait must be 3–4 words and include planet/house reference in parentheses.
4. Respond STRICTLY in JSON.
5. Do NOT include any extra keys or text.

JSON FORMAT:
{
  "personality_summary": string,
  "positive_traits": string[],
  "negative_traits": string[]
}
`;
  } else if (consultationMode === "Personalized") {
    prompt = `
${rules}

You are analyzing a single birth chart and answering the user's question as a purohit.

Kundli:
${JSON.stringify(kundli1)}

User Question:
"${query}"

Instructions:
1. Answer in EXACTLY 6–7 lines.
2. Each line must be a separate string inside an array.
3. If the question involves:
   - marriage
   - children
   - job
   - major life event
   → You MUST mention at least one specific YEAR.
4. Remedies:
   - 1 easy remedy
   - 1 costly remedy
5. Respond STRICTLY in JSON.
6. Do NOT add any other keys.

JSON FORMAT:
{
  "answer": string[],
  "easy_remedy": string,
  "costly_remedy": string
}
`;
  } else if (consultationMode === "Kundli Matching") {
    prompt = `
${rules}

You are explaining a traditional Ashtakoota (Guna Milan) result.
The points below are already calculated. Do NOT change or recalculate them.

Partner 1 (Gender: ${gender1}):
${JSON.stringify(kundli1)}

Partner 2 (Gender: ${gender2}):
${JSON.stringify(kundli2)}

Guna Milan: ${guna.total_score} out of ${guna.out_of}
${kootaLines(guna)}

Instructions:
1. Write a 4–5 line compatibility summary as ONE string.
2. Mention the strongest kootas and the weakest ones by name.
3. If Nadi scores 0 (Nadi dosha) or Bhakoot/Rasi scores 0 (Bhakoot dosha), say so plainly and name one traditional remedy.
4. Respond STRICTLY in JSON.

JSON FORMAT:
{
  "compatibility_summary": string
}
`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.6,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0].message.content;
  if (consultationMode !== "Kundli Matching") return content;

  // Score and verdict come from the calculation, never from the model.
  const { compatibility_summary } = JSON.parse(content);
  return JSON.stringify({
    compatibility_summary,
    score: guna.total_score,
    out_of: guna.out_of,
    verdict: gunaVerdict(guna.total_score),
    kootas: KOOTAS.map(([key, name]) => ({
      name,
      score: guna[key]?.score,
      out_of: guna[key]?.out_of,
    })),
  });
}
