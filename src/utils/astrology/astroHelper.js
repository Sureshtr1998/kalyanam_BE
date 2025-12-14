import axios from "axios";
import { DateTime } from "luxon";

export const getAstroApiData = async (dob, place) => {
  try {
    const geoRes = await axios.get(
      "https://nominatim.openstreetmap.org/search",
      {
        params: { q: place, format: "json", limit: 1 },
        headers: { "User-Agent": "MatrimonyAstrologyApp/1.0" },
      }
    );

    const location = geoRes.data[0];
    const latitude = parseFloat(location.lat);
    const longitude = parseFloat(location.lon);

    const tzRes = await axios.get(
      "http://api.timezonedb.com/v2.1/get-time-zone",
      {
        params: {
          key: process.env.TIMEZONEDB_KEY,
          format: "json",
          by: "position",
          lat: latitude,
          lng: longitude,
        },
      }
    );

    const zoneName = tzRes.data.zoneName;

    const birthDate = DateTime.fromJSDate(dob, {
      zone: zoneName,
    });
    const timezone = birthDate.offset / 60;

    const year = birthDate.year;
    const month = birthDate.month;
    const date = birthDate.day;
    const hours = birthDate.hour;
    const minutes = birthDate.minute;
    const seconds = birthDate.second;

    return {
      year,
      month,
      date,
      hours,
      minutes,
      seconds,
      latitude,
      longitude,
      timezone,
    };
  } catch (er) {
    throw er;
  }
};

const getRandomInt = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

export const getAstrologyDelay = () => {
  const now = new Date();
  const currentHour = now.getHours();

  // Case 1: Between 8 AM and 10 PM
  if (currentHour >= 8 && currentHour < 22) {
    const randomMinutes = getRandomInt(25, 41);
    return `${randomMinutes}m`;
  }

  // Case 2: After 10 PM or before 8 AM → next day morning
  const targetDate = new Date(now);

  // Move to next day if after 10 PM
  if (currentHour >= 22) {
    targetDate.setDate(targetDate.getDate() + 1);
  }

  // Random time between 8:12 AM – 8:51 AM
  targetDate.setHours(8);
  targetDate.setMinutes(getRandomInt(12, 51));
  targetDate.setSeconds(0);

  const delayMs = targetDate.getTime() - now.getTime();
  const delayMinutes = Math.ceil(delayMs / (1000 * 60));

  return `${delayMinutes}m`;
};
