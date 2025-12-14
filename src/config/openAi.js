import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

export async function generateAstroInsights({
  kundli1,
  kundli2 = null,
  query = "",
  gender1,
  gender2,
  consultationMode,
}) {
  let prompt = "";

  if (consultationMode === "Overview") {
    prompt = `
${GLOBAL_RULES}

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
${GLOBAL_RULES}

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
${GLOBAL_RULES}

You are analyzing marriage compatibility using traditional Guna Milan.

Partner 1 (Gender: ${gender1}):
${JSON.stringify(kundli1)}

Partner 2 (Gender: ${gender2}):
${JSON.stringify(kundli2)}

Instructions:
1. Provide a 3–4 line compatibility summary as ONE string.
2. Give a score from 0 to 100.
3. Verdict rules:
   - >= 80 → "Excellent Match"
   - 65–79 → "Good Match"
   - 50–64 → "Average Match"
   - < 50 → "Does Not Match"
4. Respond STRICTLY in JSON.

JSON FORMAT:
{
  "compatibility_summary": string,
  "score": number,
  "verdict": string
}
`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.6,
  });

  return response.choices[0].message.content;
}
