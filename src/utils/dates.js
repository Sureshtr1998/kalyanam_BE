import { DateTime } from "luxon";

// Birth dates/times are stored as "floating" wall-clock values: the digits the
// user typed are saved as if they were UTC (10:30 entered => 10:30Z stored),
// independent of the browser's or the server's timezone. Readers must use UTC
// getters, and astrology re-attaches the birthplace timezone when computing.
const FLOATING_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/** Parses "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (or "YYYY-MM-DD HH:mm"). */
export const parseFloatingDate = (value) => {
  if (!value || typeof value !== "string") return null;
  const m = value.trim().match(FLOATING_RE);
  if (!m) return null;
  const dt = DateTime.fromObject(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: m[4] ? Number(m[4]) : 0,
      minute: m[5] ? Number(m[5]) : 0,
    },
    { zone: "utc" }
  );
  return dt.isValid ? dt.toJSDate() : null;
};

/** Wall-clock parts of a floating date. */
export const floatingParts = (date) => {
  const dt = DateTime.fromJSDate(new Date(date), { zone: "utc" });
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
  };
};

export const ageInYears = (date) => {
  const { year, month, day } = floatingParts(date);
  const today = DateTime.now().setZone("Asia/Kolkata");
  let age = today.year - year;
  if (today.month < month || (today.month === month && today.day < day)) {
    age -= 1;
  }
  return age;
};
