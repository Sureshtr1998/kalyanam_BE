// astrologyApi.js
import axios from "axios";
import dotenv from "dotenv";
import { withRetry } from "../utils/astrology/astroHelper.js";

dotenv.config();

const API_URL = "https://json.freeastrologyapi.com/planets";
const ASHTAKOOT_URL = "https://json.freeastrologyapi.com/match-making/ashtakoot-score";
const API_KEY = process.env.FREE_ASTRO_API_KEY;

// The API reads chart options from `config`; anything else is ignored.
const CONFIG = {
  observation_point: "topocentric",
  ayanamsha: "lahiri",
  language: "en",
};

const HEADERS = {
  "Content-Type": "application/json",
  "x-api-key": API_KEY,
};

// The free plan allows 1 request/second, so calls are retried in-process.
const post = (url, body) =>
  withRetry(() => axios.post(url, body, { headers: HEADERS, timeout: 15000 }));

export const getPlanetPositions = async (birthDetails) => {
  try {
    const response = await post(API_URL, { ...birthDetails, config: CONFIG });
    return response.data;
  } catch (error) {
    console.error("Error fetching planetary positions:", error);
    throw error;
  }
};

/**
 * Traditional Ashtakoota (Guna Milan) score out of 36, from the Moon's
 * nakshatra and rashi of both charts. Bride is the female chart.
 */
export const getAshtakootScore = async (female, male) => {
  const response = await post(ASHTAKOOT_URL, { female, male, config: CONFIG });
  return response.data?.output;
};

export default getPlanetPositions;
