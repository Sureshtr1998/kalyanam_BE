// astrologyApi.js
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const API_URL = "https://json.freeastrologyapi.com/planets";
const API_KEY = process.env.FREE_ASTRO_API_KEY;

export const getPlanetPositions = async (birthDetails) => {
  try {
    const response = await axios.post(
      API_URL,
      {
        ...birthDetails,
        settings: {
          observation_point: "topocentric",
          ayanamsha: "lahiri",
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("Error fetching planetary positions:", error);
    throw error;
  }
};

export default getPlanetPositions;
