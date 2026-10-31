import axios from "axios";
import { DateTime } from "luxon";
import { floatingParts } from "../dates.js";
import { HttpError } from "../payments.js";

export const geocodePlace = async (place) => {
  const geoRes = await axios.get("https://nominatim.openstreetmap.org/search", {
    params: { q: place, format: "json", limit: 1 },
    headers: {
      "User-Agent": "SeethaRamaKalyana/1.0 (contactus@seetharamakalyana.in)",
    },
    timeout: 10000,
  });

  const location = geoRes.data?.[0];
  if (!location) {
    throw new HttpError(
      400,
      `We couldn't find "${place}". Please enter it as City, State, Country.`
    );
  }
  return {
    latitude: parseFloat(location.lat),
    longitude: parseFloat(location.lon),
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a flaky third-party call a few times in-process, waiting just over
 * a second between tries (the free astrology/timezone APIs allow 1 req/s).
 * Errors we raised on purpose (HttpError, e.g. unknown place) are not retried.
 */
export const withRetry = async (fn, { tries = 3, waitMs = 1100 } = {}) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError || attempt >= tries) throw err;
      await sleep(waitMs * attempt);
    }
  }
};

/** Coordinates picked in the browser's place search, when present and sane. */
export const validCoords = (c) =>
  !!c &&
  Number.isFinite(c.lat) &&
  Number.isFinite(c.lng) &&
  Math.abs(c.lat) <= 90 &&
  Math.abs(c.lng) <= 180;

/**
 * Builds the planets-API payload for a birth.
 * `dob` is a floating wall-clock date (see utils/dates.js): its UTC digits are
 * the local time at the birthplace, so we attach the birthplace's own
 * timezone (with historic DST rules) instead of converting from UTC.
 */
export const getAstroApiData = async (dob, place, coords) => {
  const { latitude, longitude } = validCoords(coords)
    ? { latitude: coords.lat, longitude: coords.lng }
    : await geocodePlace(place);

  // timezonedb's free tier allows 1 request/second; a kundli match makes two
  // lookups back to back, so retry here instead of failing the whole job
  // (which makes QStash retry with a backoff of minutes).
  const zoneName = await withRetry(async () => {
    const tzRes = await axios.get(
      // HTTPS so the API key isn't sent in clear text.
      "https://api.timezonedb.com/v2.1/get-time-zone",
      {
        params: {
          key: process.env.TIMEZONEDB_KEY,
          format: "json",
          by: "position",
          lat: latitude,
          lng: longitude,
        },
        timeout: 10000,
      }
    );
    if (!tzRes.data?.zoneName) {
      throw new Error(
        `Timezone lookup failed for ${place}: ${tzRes.data?.message}`
      );
    }
    return tzRes.data.zoneName;
  });

  const { year, month, day, hour, minute } = floatingParts(dob);
  const birthDate = DateTime.fromObject(
    { year, month, day, hour, minute },
    { zone: zoneName }
  );

  return {
    year: birthDate.year,
    month: birthDate.month,
    date: birthDate.day,
    hours: birthDate.hour,
    minutes: birthDate.minute,
    seconds: 0,
    latitude,
    longitude,
    timezone: birthDate.offset / 60,
  };
};

const getRandomInt = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

// Readings are only delivered during working hours, India time.
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 21;

/**
 * Delay before the reading is generated, in India time (the server runs in UTC).
 * Normally 2–3 hours after the request; if that would land outside 9 AM–9 PM,
 * it goes out at a random time between 9 and 11 AM on the next working morning.
 */
export const getAstrologyDelay = (now = DateTime.now().setZone("Asia/Kolkata")) => {
  let target = now.plus({ minutes: getRandomInt(120, 180) });

  const inWorkingHours = (t) => t.hour >= WORK_START_HOUR && t.hour < WORK_END_HOUR;
  if (!inWorkingHours(target)) {
    let morning = now.set({ hour: WORK_START_HOUR, minute: 0, second: 0, millisecond: 0 });
    if (now >= morning) morning = morning.plus({ days: 1 });
    target = morning.plus({ minutes: getRandomInt(0, 120) });
  }

  const delayMinutes = Math.ceil(target.diff(now, "minutes").minutes);
  return `${Math.max(1, delayMinutes)}m`;
};
