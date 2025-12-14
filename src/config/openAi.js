import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// COMMON RULE: Every output must use Sanskrit-style planet & rashi names
const namingRule = `
IMPORTANT INSTRUCTION:
- Always use Vedic/Sanskrit-style names for planets:
  Surya, Chandra, Mangala, Budha, Guru, Shukra, Shani, Rahu, Ketu.
- Always use Vedic rashi names:
  Mesha, Vrishabha, Mithuna, Karka, Simha, Kanya, Tula,
  Vrischika, Dhanu, Makara, Kumbha, Meena.
- DO NOT use English names like Sun, Moon, Aries, Capricorn, etc.
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
You are a Vedic astrology expert. Analyze the following birth chart:
Kundli: ${JSON.stringify(kundli1)}

${namingRule}

Instructions:
1. Provide a 3-4 line personality summary in a single string.
2. Provide 7 traits: 4 positive, 3 negative, each 3-4 words, include relevant planets and houses in parentheses.
3. Respond strictly in JSON with the following keys:
   - "personality_summary": string
   - "positive_traits": array of 4 strings
   - "negative_traits": array of 3 strings
4. Do NOT include any other keys or text outside JSON.

Example response:
{
    "personality_summary": "You are introspective and sensitive, with deep emotional intelligence and a serious, responsible approach to life. Strong ambitions drive you, along with a disciplined mindset and a tendency to think deeply. Relationships and friendships are important, but you may often feel a sense of inner restlessness or detachment.",
    "positive_traits": [
        "Disciplined and responsible (Shani Meena lagna)",
        "Emotionally intelligent (Chandra Makara sthana)",
        "Ambitious and driven (Surya Dhanu, 10th bhava)",
        "Loyal in relationships (Shukra Makara sthana)"
    ],
    "negative_traits": [
        "Prone to melancholy (Chandra-Mangala Makara conjunction)",
        "Overly self-critical (Shani lagna, Meena)",
        "Detached or aloof (Ketu Kumbha, 12th bhava)"
    ]
}
`;
  } else if (consultationMode === "Personalized") {
    prompt = `
You are a Vedic astrology expert. Analyze the following birth chart:
Kundli: ${JSON.stringify(kundli1)}
User question: "${query}"

${namingRule}

Instructions:
1. Provide the answer in 6-7 lines, each line as a separate string.
2. Include remedies: 1 easy, 1 costly.
3. Respond strictly in JSON with the following keys:
   - "answer": array of strings (each string is one line of the answer)
   - "easy_remedy": string
   - "costly_remedy": string
4. Do NOT use any other keys like "analysis", "traits", or nested arrays.

Example response:
{
  "answer": [
    "You are likely to get married between 27-29 years.",
    "Your spouse is expected to be compassionate and ambitious.",
    "You will have a strong career focus before marriage.",
    "Family support will be significant in your life decisions.",
    "Financial stability is highlighted in your chart.",
    "You should avoid hasty decisions during Mars transits.",
    "Spiritual practices will bring peace and clarity."
  ],
  "easy_remedy": "Wear a red coral on Tuesday morning after puja.",
  "costly_remedy": "Perform a 7-day Shukra homa at a local temple."
}
`;
  } else if (consultationMode === "Kundli Matching") {
    prompt = `
You are a Vedic astrology expert. Analyze the birth charts for marriage compatibility:
Partner 1 (gender: ${gender1}): ${JSON.stringify(kundli1)}
Partner 2 (gender: ${gender2}): ${JSON.stringify(kundli2)}

${namingRule}

Instructions:
1. A 3-4 line summary of compatibility, highlighting strengths and challenges.
2. Calculate a compatibility score on a 0-100 scale based on Guna Milan principles.
3. Provide a verdict: 
   - "Excellent Match" if score >= 80
   - "Good Match" if score is 65-79
   - "Average Match" if score is 50-64
   - "Does Not Match" if score < 50
4. Respond strictly in JSON format like this:

{
  "compatibility_summary": "...",
  "score": 72,
  "verdict": "Good Match"
}
`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  return response.choices[0].message.content;
}
