import { ageInYears } from "./dates.js";

/*
 * Two-way matching.
 *
 * A member's partner preferences decide two things:
 *  1. which profiles they see (their own filters), and
 *  2. who is allowed to see THEM: if a member only wants, say, Kannada
 *     speakers aged 27-33, nobody outside that group gets their profile.
 * An empty preference means "anyone".
 */

// partner preference field -> where the viewer's own value lives
const LIST_PREFS = {
  caste: "basic.caste",
  subCaste: "basic.subCaste",
  motherTongue: "basic.motherTongue",
  martialStatus: "basic.martialStatus",
  qualification: "basic.qualification",
  employedIn: "personal.employedIn",
  country: "personal.country",
};

const PUBLIC_FIELDS =
  "-basic.password -basic.email -basic.mobile -basic.alternateMob -personal.address -hideProfiles -interests -transactions -astrology -shortlisted -profileViews -__v";

export const publicProjection = PUBLIC_FIELDS;

const get = (obj, path) =>
  path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toList = (v) =>
  (Array.isArray(v) ? v : v ? String(v).split(",") : [])
    .map((x) => String(x).trim())
    .filter(Boolean);

const emptyPref = (field) => [
  { [field]: { $exists: false } },
  { [field]: null },
  { [field]: "" },
  { [field]: { $size: 0 } },
];

export const viewerAge = (viewer) =>
  viewer?.basic?.dob ? ageInYears(viewer.basic.dob) : null;

/**
 * Mongo conditions that keep only candidates whose partner preferences
 * accept `viewer`. Combine with `$and`.
 */
export const acceptsViewerQuery = (viewer) => {
  const conditions = [];

  for (const [pref, path] of Object.entries(LIST_PREFS)) {
    const value = get(viewer, path);
    if (!value) continue; // unknown about the viewer: don't exclude on it
    const field = `partner.${pref}`;
    conditions.push({
      $or: [
        ...emptyPref(field),
        { [field]: { $regex: `^${escapeRegex(value)}$`, $options: "i" } },
      ],
    });
  }

  // Ages are stored as 2-digit strings and heights (cm) as 3-digit strings,
  // so string comparison orders them correctly.
  const age = viewerAge(viewer);
  if (age !== null && age >= 10 && age <= 99) {
    const a = String(age);
    conditions.push({ $or: [...emptyPref("partner.ageFrom").slice(0, 3), { "partner.ageFrom": { $lte: a } }] });
    conditions.push({ $or: [...emptyPref("partner.ageTo").slice(0, 3), { "partner.ageTo": { $gte: a } }] });
  }

  const height = viewer?.personal?.height;
  if (height && /^\d{3}$/.test(height)) {
    conditions.push({ $or: [...emptyPref("partner.heightFrom").slice(0, 3), { "partner.heightFrom": { $lte: height } }] });
    conditions.push({ $or: [...emptyPref("partner.heightTo").slice(0, 3), { "partner.heightTo": { $gte: height } }] });
  }

  return conditions;
};

/** Same rules as `acceptsViewerQuery`, for a single loaded document. */
export const acceptsViewer = (candidate, viewer) => {
  const partner = candidate?.partner || {};

  for (const [pref, path] of Object.entries(LIST_PREFS)) {
    const wanted = toList(partner[pref]).map((x) => x.toLowerCase());
    const value = get(viewer, path);
    if (!wanted.length || !value) continue;
    if (!wanted.includes(String(value).toLowerCase())) return false;
  }

  const age = viewerAge(viewer);
  if (age !== null) {
    if (partner.ageFrom && age < Number(partner.ageFrom)) return false;
    if (partner.ageTo && age > Number(partner.ageTo)) return false;
  }

  const height = Number(viewer?.personal?.height);
  if (height) {
    if (partner.heightFrom && height < Number(partner.heightFrom)) return false;
    if (partner.heightTo && height > Number(partner.heightTo)) return false;
  }

  return true;
};

const hasId = (list = [], id) => list.some((x) => String(x) === String(id));

/** Either side has blocked the other. */
export const isBlocked = (a, b) =>
  hasId(a?.hideProfiles, b?._id) || hasId(b?.hideProfiles, a?._id);

/**
 * Whether `viewer` may see `candidate` at all: opposite gender, visible,
 * not blocked either way, and the candidate's preferences accept the viewer.
 */
export const canView = (viewer, candidate) => {
  if (!viewer || !candidate) return false;
  if (String(viewer._id) === String(candidate._id)) return false;
  if (candidate.isHidden || candidate.isCorrupted) return false;
  if (
    String(viewer.basic?.gender || "").toLowerCase() ===
    String(candidate.basic?.gender || "").toLowerCase()
  ) {
    return false;
  }
  if (isBlocked(viewer, candidate)) return false;
  return acceptsViewer(candidate, viewer);
};

export { toList, escapeRegex };
