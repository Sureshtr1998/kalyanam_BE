import User from "../models/User.js";
import razorpay from "../config/razorpay.js";
import { notify } from "../config/msg91Email.js";
import { OpsAction, OpsMail, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { fetchNewMail, sendMail } from "./mail.js";
import { handle, handleUndo, hoursFromNow, notice, propose } from "./actions.js";
import { ageInYears, parseFloatingDate } from "../utils/dates.js";

/*
 * Support mail. Every new mail is sorted; then:
 *  - company / spam / automated: ignored (no AI cost for obvious ones)
 *  - verification: the mobile AND email in the mail must match one
 *    unverified account → verified after the notice period, with a
 *    confirmation in the sender's language (never a password)
 *  - refund: a card for the admin (never automatic)
 *  - question / complaint: a drafted reply, sent after the notice period
 *  - urgent (safety, harassment, police, legal, payment dispute): admin only
 */

const COMPANY_DOMAINS = [
  "facebookmail.com", "meta.com", "google.com", "googlemail.com", "razorpay.com", "msg91.com", "vercel.com",
  "godaddy.com", "secureserver.net", "imagekit.io", "upstash.com", "mongodb.com", "github.com", "openai.com",
  "anthropic.com", "linkedin.com", "amazonses.com", "sendgrid.net", "mailchimp.com", "zoho.com",
];
const AUTOMATED = /(no-?reply|noreply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce|alerts?|newsletter|billing|marketing)@/i;

/** Company and automated mail is recognised without calling Claude. */
export const looksLikeCompany = (mail) => {
  const domain = mail.from.email.split("@")[1] || "";
  return (
    AUTOMATED.test(mail.from.email) ||
    mail.headers?.listUnsubscribe ||
    /auto-/.test(mail.headers?.autoSubmitted || "") ||
    /bulk|list/i.test(mail.headers?.precedence || "") ||
    COMPANY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`)) ||
    domain === "seetharamakalyana.in"
  );
};

const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "language", "summary", "mobile", "email", "confidence", "changes"],
  properties: {
    category: { type: "string", enum: ["company", "spam", "verification", "refund", "profile_change", "question", "complaint", "urgent"] },
    changes: {
      type: "array",
      description: "For profile_change only: each field they want corrected and the new value (dates as YYYY-MM-DD). Empty otherwise.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value"],
        properties: {
          field: { type: "string", enum: ["dob", "fullName", "gothra", "subCaste", "workCity", "qualification", "height", "occupation", "caste", "maritalStatus", "email", "mobile", "gender", "photo", "other"] },
          value: { type: "string" },
        },
      },
    },
    language: { type: "string", description: "Language and script of the mail, e.g. 'Kannada (Kannada script)', 'Kannada (Latin letters)', 'English'" },
    summary: { type: "string", description: "One sentence, English" },
    mobile: { type: "string", description: "10-digit Indian mobile number written in the mail, or empty" },
    email: { type: "string", description: "Account email written in the mail body, or empty" },
    confidence: { type: "number", description: "0 to 1" },
  },
};

const TRIAGE_SYSTEM = `You sort mail sent to the support inbox of Seetha Rama Kalyana, an Indian matrimony website.
Categories:
- company: sent by a business, vendor, newsletter, bank, platform or any automated system, not by a member or family
- spam: scams, SEO/marketing pitches, junk
- verification: a member says they can't verify their account, didn't get the OTP, or asks to be verified
- refund: asks for money back
- profile_change: asks to correct or change something on their profile (date of birth, name spelling, city, education, job, caste, photo...)
- urgent: harassment, threats, safety concerns, fake profiles cheating someone, police or legal matters, payment taken twice or other payment disputes
- complaint: unhappy about the service (not urgent)
- question: anything else a member or family asks
Extract the mobile number and account email if the sender wrote them. Detect the language and script exactly.`;

/** Company mail that needs the owner: account restrictions, removals, failed payments, rejected ads. */
const VENDOR_ALERT = /(violat|restrict|suspend|disabled|removed|rejected|disapproved|not approved|failed|declined|action required|fix (the )?issue|verify your|expir|overdue|unpaid|limit reached|blocked)/i;
const VENDOR_DOMAINS = /(facebookmail\.com|meta\.com|whatsapp\.com|razorpay\.com|msg91\.com|vercel\.com|imagekit\.io|mongodb\.com|godaddy\.com|secureserver\.net|upstash\.com|github\.com|google\.com|anthropic\.com)$/i;

export const vendorAlert = (mail) => {
  const domain = mail.from.email.split("@")[1] || "";
  if (!VENDOR_DOMAINS.test(domain) && !/meta for business|whatsapp|razorpay/i.test(mail.from.name || "")) return null;
  const text = `${mail.subject} ${mail.text.slice(0, 400)}`;
  return VENDOR_ALERT.test(text) ? mail.subject || "Account alert" : null;
};

/** Meta / MSG91 mails about balance, top-ups or payments: funds are the owner's to watch, so no WhatsApp. */
const FUNDS_SENDERS = /(facebookmail\.com|meta\.com|msg91\.com)$/i;
const FUNDS_WORDS = /(balance|funds|top.?up|recharge|insufficient|prepaid|wallet|payment|billing|invoice|spending limit|unpaid|overdue)/i;
export const fundsMail = (mail) =>
  FUNDS_SENDERS.test(mail.from.email.split("@")[1] || "") && FUNDS_WORDS.test(`${mail.subject} ${mail.text.slice(0, 400)}`);

const normalizeMobile = (s) => String(s || "").replace(/\D/g, "").slice(-10);

/** A "Delivery failed" mail about something we sent. */
export const isBounce = (mail) =>
  /^(mailer-daemon|postmaster)@/i.test(mail.from.email) ||
  /(delivery (status notification|failure|has failed)|undeliver|returned mail|message delivery failure|failure notice)/i.test(mail.subject || "");

const OUR_DOMAIN = /@seetharamakalyana\.in$/i;
/** The addresses that bounced (ours left out), and whether it was one of our reminders. */
export const bounceDetails = (mail) => {
  const text = `${mail.subject || ""}\n${mail.text || ""}`;
  const recipients = [...new Set((text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).map((e) => e.toLowerCase()))].filter(
    (e) => !OUR_DOMAIN.test(e) && !/^(mailer-daemon|postmaster)@/i.test(e) && !/secureserver\.net$/i.test(e)
  );
  const reminder = /(verify your profile|still waiting to be verified)/i.test(text);
  return { recipients: recipients.slice(0, 5), reminder };
};

/**
 * Bounced mail: a reminder that bounced stops that member's email reminders
 * (the address is wrong); a bounced reply is a normal note (never WhatsApp).
 */
const handleBounce = async (mail, doc) => {
  const { recipients, reminder } = bounceDetails(mail);
  if (reminder) {
    if (recipients.length) {
      await User.updateMany({ "basic.email": { $in: recipients } }, { $set: { "reminders.off": true, "reminders.bounced": true } });
    }
    return;
  }
  await notice("support", {
    type: "support.bounce",
    priority: "normal",
    title: `A mail didn't reach ${recipients[0] ?? "a member"}`.slice(0, 160),
    reason: `Their mailbox refused it (wrong or closed address). Subject: ${mail.subject || "(none)"}.`,
    effect: "Nothing to do unless they write again from another address.",
    payload: { dedupeKey: `bounce:${recipients[0] ?? mail.messageId}` },
    ref: { kind: "mail", id: String(doc._id) },
  });
};

/**
 * Razorpay payments (last `days`) made with any of these emails or this mobile,
 * for refund requests from people with no account or no payment on it (e.g. they
 * paid but never finished registering). Read only: nothing is refunded here.
 * Each: { paymentId, amount, note, date, source: "razorpay", refunded, refundedOn }.
 */
export const findRazorpayPayments = async ({ emails = [], mobile = "", days = 60, now = Date.now() } = {}) => {
  const wanted = new Set(emails.map((e) => String(e || "").toLowerCase().trim()).filter(Boolean));
  const mobile10 = normalizeMobile(mobile);
  if (!wanted.size && mobile10.length !== 10) return [];
  const from = Math.floor((now - days * 86400000) / 1000);
  const to = Math.floor(now / 1000);
  const found = [];
  for (let skip = 0; skip < 3000; skip += 100) {
    const page = await razorpay.payments.all({ from, to, count: 100, skip });
    const items = page?.items ?? [];
    for (const p of items) {
      if (!["captured", "refunded"].includes(p.status)) continue;
      const byEmail = wanted.has(String(p.email || "").toLowerCase().trim());
      const byMobile = mobile10.length === 10 && normalizeMobile(p.contact) === mobile10;
      if (!byEmail && !byMobile) continue;
      const refunded = p.status === "refunded" || (Number(p.amount_refunded) || 0) >= (Number(p.amount) || 0);
      found.push({
        paymentId: p.id,
        amount: (Number(p.amount) || 0) / 100,
        note: p.description || p.notes?.purpose || "Razorpay payment",
        date: p.created_at ? new Date(p.created_at * 1000) : undefined,
        source: "razorpay",
        matchedBy: byEmail ? "email" : "mobile",
        refunded,
      });
    }
    if (items.length < 100) break;
  }
  return found;
};

const day = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "");

const replySystem = (brief) => `You write email replies for the support team of Seetha Rama Kalyana.
${brief}
Write the reply in exactly the language and script given. Be warm, short (under 120 words) and specific.
Sign off as "Team Seetha Rama Kalyana". Output only the reply body, no subject line.`;

const draftReply = (config, mail, instruction, tier = "sort") =>
  ask({
    task: "support.reply",
    tier,
    system: replySystem(config.brief),
    prompt: `Language and script to reply in: ${mail.language}
Their mail (subject "${mail.subject}"):
"""${mail.text.slice(0, 3000)}"""

What to say: ${instruction}`,
    maxTokens: 600,
  });

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "answered"],
  properties: {
    reply: { type: "string", description: "The reply body" },
    answered: { type: "boolean", description: "false when the facts didn't answer what they asked, so the reply only says the team will check" },
  },
};

/** Drafts the reply to a question or complaint, and says whether the brief answered it. */
const draftAnswer = async (config, mail, tier) => {
  const out = await ask({
    task: "support.reply",
    tier,
    system: `${replySystem(config.brief)}
Also say whether the facts above answered what they asked ("answered": false when the reply can only say the team will check).`,
    prompt: `Language and script to reply in: ${mail.language}
Their mail (subject "${mail.subject}"):
"""${mail.text.slice(0, 3000)}"""

What to say: Answer their question using only the facts in the brief. If the brief doesn't cover it, say the team will check and reply soon.`,
    schema: ANSWER_SCHEMA,
    maxTokens: 700,
  });
  if (typeof out === "string") return { reply: out, answered: true };
  return { reply: String(out?.reply ?? ""), answered: out?.answered !== false };
};

/** From this many mails, a member the agent couldn't help goes to the owner's WhatsApp. */
export const REPEAT_ALERT_AT = 3;

/**
 * A member who has written 3+ times (in 30 days, since the owner last acted on
 * their mails) about something only the owner can settle: a refund, a question
 * the brief doesn't answer, an account it couldn't match. Urgent: WhatsApp.
 */
const repeatAlert = async (m, who, doc) => {
  const email = m.from.email;
  const lastOwnerAct = await OpsAction.findOne({
    module: "support",
    "payload.to": email,
    status: { $in: ["done", "cancelled"] },
    decidedBy: { $nin: [null, "agent"] },
  })
    .sort({ updatedAt: -1 })
    .select("updatedAt")
    .lean();
  const since = Math.max(Date.now() - 30 * 86400000, lastOwnerAct?.updatedAt ? new Date(lastOwnerAct.updatedAt).getTime() : 0);
  const mails = await OpsMail.find({ "from.email": email, needsTeam: true, createdAt: { $gt: new Date(since) } })
    .sort({ createdAt: 1 })
    .select("category summary")
    .lean();
  if (mails.length < REPEAT_ALERT_AT) return null;
  const refund = mails.some((x) => x.category === "refund");
  return notice("support", {
    type: "support.repeat_mail",
    priority: "urgent",
    title: `${who} has mailed ${mails.length} times${refund ? " about a refund" : ""} and needs you`.slice(0, 160),
    reason: mails.map((x, i) => `${i + 1}) ${x.summary || x.category}`).join(" ").slice(0, 500),
    effect: refund
      ? "Refunds are never automatic: refund or reply from Ops → Support."
      : "The agent couldn't settle this on its own. Reply from Ops → Support (Format my mail helps), or add the answer to the brief.",
    payload: { dedupeKey: `repeat:${email}`, whatsappKey: `support:${email.toLowerCase()}`, to: email },
    ref: { kind: "mail", id: String(doc._id) },
  });
};

/**
 * Turns the owner's rough notes into a well-structured reply to the mail a
 * card answers, in the member's language. Adds only a greeting, paragraphs and
 * the sign-off: never a fact, promise, date, price or link the notes don't have.
 * @param {{ action: { payload: { inReplyTo?: string, subject?: string, to?: string } }, text: string }} p
 * @returns {Promise<string>} the formatted mail body (not saved)
 */
export const formatDraft = async ({ action, text }) => {
  const notes = String(text || "").trim();
  if (notes.length < 5) throw Object.assign(new Error("Write a sentence or two first"), { status: 400 });
  const config = await getConfig();
  const p = action.payload ?? {};
  const mail = p.inReplyTo ? await OpsMail.findOne({ messageId: p.inReplyTo }).lean() : null;
  const out = await ask({
    task: "support.format",
    tier: "sort",
    system: `You turn the support team's rough notes into a clear, well-structured email reply for Seetha Rama Kalyana.
${config.brief}
Rules:
- Keep exactly the meaning and facts of the notes. Add nothing they don't say: no new promises, refunds, dates, prices, links, steps or confirmations. Every sentence must come from the notes; only the greeting, the closing line and the sign-off are yours.
- Use the member's mail only to understand the context and to get their name; never repeat or confirm anything from it that the notes don't say.
- Structure: a greeting ("Dear <their name>," when the name is known, else "Dear Member,"), then short paragraphs in a sensible order; a numbered list only when the notes give steps; a short closing line; then the sign-off on its own lines: "Warm regards," and "Team Seetha Rama Kalyana".
- Fix grammar and spelling; warm, polite and plain. Plain text only (no markdown, no asterisks).
- Language: ${mail?.language ? `write in ${mail.language} (the member's language and script), unless the notes clearly ask for another language` : "write in the language of the notes"}.
- Never include a password or anyone else's contact details.
Output only the email body, no subject line.`,
    prompt: `${mail ? `The member's mail (from ${mail.from?.name || "the member"}, subject "${mail.subject ?? p.subject ?? ""}"):
"""${String(mail.text ?? "").slice(0, 2500)}"""

` : p.subject ? `Subject of the conversation: "${p.subject}"

` : ""}The team's notes for the reply:
"""${notes.slice(0, 3000)}"""`,
    maxTokens: 900,
  });
  const body = String(out || "").trim();
  if (!body) throw new Error("Couldn't format the mail; try again");
  return body.slice(0, 5000);
};

/** Reads new mail and turns each into actions. Returns how many were read. */
export const runSupportCycle = async () => {
  const config = await getConfig();
  const mails = await fetchNewMail(config.mailLastUid || 0);
  const delay = config.limits.supportDelayHours;
  for (const m of mails) {
    try {
      await handleMail(config, m, delay);
    } catch (err) {
      console.error("[ops] mail", m.uid, err.message);
    }
    config.mailLastUid = Math.max(config.mailLastUid || 0, m.uid);
  }
  if (mails.length) await config.save();
  return mails.length;
};

const WAITING = ["scheduled", "needs_you", "shadow"];

/**
 * Once: open refund cards made before one-card-per-member and the Razorpay
 * lookup. Several cards from one person fold into the newest; a card with no
 * payment looks it up in Razorpay by the person's email (read only, nothing
 * is refunded). Returns how many cards changed.
 */
export const refreshOpenRefunds = async () => {
  const cards = await OpsAction.find({ type: "support.refund", status: { $in: WAITING } }).sort({ createdAt: 1 });
  const byPerson = new Map();
  for (const c of cards) {
    const key = String(c.payload?.to || c._id).toLowerCase();
    byPerson.set(key, [...(byPerson.get(key) ?? []), c]);
  }
  let changed = 0;
  for (const list of byPerson.values()) {
    const keep = list.at(-1);
    for (const old of list.slice(0, -1)) {
      old.status = "cancelled";
      old.decidedBy = "agent";
      old.error = "Replaced: they wrote again, and the newest refund card covers all their mails.";
      await old.save();
      changed += 1;
    }
    let reason = keep.reason ?? "";
    if (list.length > 1 && !/^They wrote \d+ times/.test(reason)) reason = `They wrote ${list.length} times about this refund. ${reason}`;
    if (!(keep.payload?.payments ?? []).length && keep.payload?.to) {
      const found = await findRazorpayPayments({ emails: [keep.payload.to] }).catch(() => null);
      if (found) {
        keep.payload = { ...keep.payload, payments: found };
        keep.markModified("payload");
        reason += found.length
          ? ` Found in Razorpay by their email: ${found.map((p) => `₹${p.amount} on ${day(p.date)}${p.refunded ? " (already refunded)" : ""}`).join(", ")}.`
          : " No payment with their email in Razorpay in the last 60 days: ask them for the payment ID or UPI reference.";
      }
    }
    if (reason !== keep.reason) {
      keep.reason = reason;
      await keep.save();
      changed += 1;
    }
  }
  return changed;
};

/** Cancels the older reply cards a newer mail now covers, and says so on the new card. */
const supersede = async (earlier, doc) => {
  if (!earlier.length) return;
  await OpsAction.updateMany(
    { _id: { $in: earlier.map((a) => a._id) }, status: { $in: WAITING } },
    { $set: { status: "cancelled", decidedBy: "agent", error: "Replaced: they wrote again, and one reply now answers all their mails." } }
  );
  const fresh = await OpsAction.find({ module: "support", "ref.id": String(doc._id), status: { $in: WAITING } });
  for (const a of fresh) {
    a.reason = `They wrote ${earlier.length + 1} times; this one reply answers all of them. ${a.reason ?? ""}`;
    await a.save();
  }
};

const handleMail = async (config, m, delay) => {
  if (await OpsMail.exists({ uid: m.uid, messageId: m.messageId })) return;
  const doc = await OpsMail.create({ ...m, category: "unknown" });

  if (isBounce(m)) {
    doc.category = "company";
    doc.status = "ignored";
    await handleBounce(m, doc).catch((err) => console.error("[ops] bounce", err.message));
    return doc.save();
  }

  if (looksLikeCompany(m)) {
    doc.category = "company";
    doc.status = "ignored";
    const alert = vendorAlert(m);
    if (alert) {
      await notice("support", {
        type: "support.vendor_alert",
        priority: "urgent",
        title: `${m.from.name || m.from.email}: ${alert}`,
        reason: m.text.replace(/\s+/g, " ").slice(0, 300),
        effect: "Alert only. Open the mail in contactus@ and act on it.",
        payload: {
          dedupeKey: `vendor:${alert.toLowerCase().slice(0, 80)}:${new Date().toISOString().slice(0, 10)}`,
          ...(fundsMail(m) ? { whatsapp: false } : {}),
        },
        ref: { kind: "mail", id: String(doc._id) },
      });
    }
    return doc.save();
  }

  // Mails from the same person still waiting for a reply: one reply answers them all.
  const earlier = await OpsAction.find({
    module: "support",
    type: "support.reply",
    status: { $in: WAITING },
    "payload.to": m.from.email,
    "ref.kind": "mail",
  }).lean();
  const earlierMails = earlier.length
    ? await OpsMail.find({ _id: { $in: earlier.map((a) => a.ref.id) } }).select("text").lean()
    : [];
  const thread = earlierMails.length
    ? `${m.text.slice(0, 3000)}\n\n--- Their earlier mail${earlierMails.length > 1 ? "s" : ""}, not answered yet ---\n${earlierMails.map((e) => String(e.text || "").slice(0, 1500)).join("\n---\n")}`
    : m.text;
  const finish = async () => {
    await supersede(earlier, doc);
    doc.status = "handled";
    const saved = await doc.save();
    if (doc.needsTeam) await repeatAlert(m, who, doc).catch((err) => console.error("[ops] repeat alert", err.message));
    return saved;
  };

  const t = await ask({
    task: "support.triage",
    tier: "sort",
    system: TRIAGE_SYSTEM,
    prompt: `From: ${m.from.name} <${m.from.email}>\nSubject: ${m.subject}\n\n${thread.slice(0, 6000)}`,
    schema: TRIAGE_SCHEMA,
    maxTokens: 400,
  });
  Object.assign(doc, { category: t.category, language: t.language, summary: t.summary });
  const mail = { ...m, text: thread, language: t.language };
  const ref = { kind: "mail", id: String(doc._id) };
  const who = `${m.from.name || m.from.email}`;

  if (t.category === "company" || t.category === "spam") {
    doc.status = "ignored";
    return doc.save();
  }

  if (t.category === "verification") {
    const mobile = normalizeMobile(t.mobile);
    const email = String(t.email || "").toLowerCase().trim();
    const byMobile = mobile.length === 10 ? await User.findOne({ "basic.mobile": { $regex: `${mobile}$` } }) : null;
    const emails = [m.from.email, email].filter(Boolean);
    const matches = byMobile && emails.includes(String(byMobile.basic.email).toLowerCase());
    if (byMobile && matches && byMobile.isVerified) {
      doc.matchedUser = byMobile._id;
      doc.draft = await draftReply(config, mail, "Tell them their account is already verified and they can log in with their email and password. If they forgot the password, use 'Forgot password' on the login page.");
      await propose("support", {
        type: "support.reply",
        title: `Reply to ${who}: already verified`,
        reason: `${t.summary} Account ${byMobile.basic.uniqueId ?? ""} is already verified.`,
        effect: `Sends the drafted reply in ${t.language}.`,
        payload: { to: m.from.email, subject: m.subject, inReplyTo: m.messageId, draft: doc.draft },
        ref,
        runAt: hoursFromNow(delay),
      });
    } else if (byMobile && matches) {
      doc.matchedUser = byMobile._id;
      doc.draft = await draftReply(config, mail, "Tell them their account is now verified and they can log in with their registered email and password (use 'Forgot password' if needed). Thank them for their patience. Never include a password.");
      await propose("support", {
        type: "support.verify",
        title: `Verify ${byMobile.basic.fullName} (${mobile})`,
        reason: `${t.summary} The mobile ${mobile} and email ${byMobile.basic.email} in the mail match one unverified account.`,
        effect: `Marks the account verified, sends the usual "profile verified" email and this reply in ${t.language}.`,
        payload: { userId: String(byMobile._id), to: m.from.email, subject: m.subject, inReplyTo: m.messageId, draft: doc.draft },
        ref,
        runAt: hoursFromNow(delay),
      });
    } else {
      doc.needsTeam = true;
      await propose("support", {
        type: "support.reply",
        status: "needs_you",
        title: `Can't match ${who} to an account`,
        reason: `${t.summary} Mobile "${t.mobile || "none"}", email "${email || m.from.email}" don't point to the same account${byMobile ? ` (the mobile belongs to ${byMobile.basic.email})` : ""}.`,
        effect: "Waits for you. Ask them for the registered mobile and email, or verify by hand in Members.",
        payload: { to: m.from.email, subject: m.subject, inReplyTo: m.messageId, draft: await draftReply(config, mail, "Ask them to reply with the mobile number and email they registered with, so we can verify their account.") },
        ref,
      });
    }
    return finish();
  }

  if (t.category === "profile_change") {
    await handleProfileChange(config, doc, mail, t, ref, who, delay);
    return finish();
  }

  if (t.category === "refund") {
    const user = await User.findOne({ "basic.email": { $in: [m.from.email, String(t.email || "").toLowerCase()] } }).select("basic transactions isVerified createdAt").lean();
    let payments = (user?.transactions ?? [])
      .filter((x) => x.paymentId && x.amountPaid > 0 && !x.refundId)
      .map((x) => ({ paymentId: x.paymentId, amount: x.amountPaid, note: x.note, date: x.dateOfTrans }));
    // Paid but no account (or none on it): look the payment up in Razorpay by their email or mobile.
    let lookup = "";
    if (!payments.length) {
      const found = await findRazorpayPayments({ emails: [m.from.email, t.email, user?.basic?.email], mobile: t.mobile || user?.basic?.mobile }).catch((err) => {
        lookup = ` Razorpay couldn't be searched (${err?.error?.description || err.message}).`;
        return null;
      });
      if (found) {
        payments = found;
        const open = found.filter((p) => !p.refunded);
        const done = found.filter((p) => p.refunded);
        lookup = found.length
          ? ` Found in Razorpay by their ${[...new Set(found.map((p) => p.matchedBy))].join(" and ")}: ${found.map((p) => `₹${p.amount} on ${day(p.date)}${p.refunded ? " (already refunded)" : ""}`).join(", ")}.${done.length && !open.length ? " Razorpay shows it already refunded: tell them it can take 5–7 working days to reach them." : ""}`
          : " No payment with their email or mobile in Razorpay in the last 60 days: ask them for the payment ID or UPI reference.";
      }
    }
    doc.matchedUser = user?._id;
    doc.needsTeam = true;
    doc.draft = await draftReply(config, mail, "Confirm we have refunded their payment; it reaches the original payment method in 5–7 working days.");
    // One refund card per member: earlier open ones from the same person are folded into this one.
    const earlierRefunds = await OpsAction.find({ module: "support", type: "support.refund", status: { $in: WAITING }, "payload.to": m.from.email }).lean();
    const again = earlierRefunds.length ? `They wrote ${earlierRefunds.length + 1} times about this refund. ` : "";
    const card = await propose("support", {
      type: "support.refund",
      status: "needs_you",
      priority: "normal",
      title: `Refund request from ${who}`,
      reason: `${again}${t.summary} ${user ? `Member ${user.basic.fullName}, joined ${new Date(user.createdAt).toLocaleDateString("en-IN")}, ${(user.transactions ?? []).filter((x) => x.paymentId && x.amountPaid > 0 && !x.refundId).length} refundable payment(s) on the account.` : "No account found with this email."}${lookup}`,
      effect: "Waits for you: Refund (Razorpay) or Ignore. Refunds are never automatic.",
      payload: { userId: user?._id ? String(user._id) : null, payments, to: m.from.email, subject: m.subject, inReplyTo: m.messageId, draft: doc.draft },
      ref,
    });
    if (card && earlierRefunds.length) {
      await OpsAction.updateMany(
        { _id: { $in: earlierRefunds.map((a) => a._id) }, status: { $in: WAITING } },
        { $set: { status: "cancelled", decidedBy: "agent", error: "Replaced: they wrote again, and the newest refund card covers all their mails." } }
      );
    }
    return finish();
  }

  // An earlier urgent mail keeps the reply urgent even if the newest one reads calmer.
  const urgent = t.category === "urgent" || earlier.some((a) => a.priority === "urgent");
  const tier = t.category === "complaint" || urgent || t.confidence < 0.6 ? "write" : "sort";
  if (urgent) {
    doc.draft = await draftReply(config, mail, "Acknowledge with care, say the team is looking into it personally today. Promise nothing else.", tier);
    doc.needsTeam = true;
  } else {
    const { reply, answered } = await draftAnswer(config, mail, tier);
    doc.draft = reply;
    doc.needsTeam = !answered;
  }
  await propose("support", {
    type: "support.reply",
    status: urgent ? "needs_you" : "scheduled",
    priority: urgent ? "urgent" : "normal",
    title: urgent ? `Urgent: ${who}` : `Reply to ${who}`,
    reason: doc.needsTeam && !urgent ? `${t.summary} The brief doesn't answer this, so the reply says the team will check.` : t.summary,
    effect: urgent ? "Waits for you. Read the mail before replying." : `Sends the drafted reply in ${t.language}.`,
    payload: { to: m.from.email, subject: m.subject, inReplyTo: m.messageId, draft: doc.draft },
    ref,
    runAt: urgent ? undefined : hoursFromNow(delay),
  });
  return finish();
};

/*
 * Profile corrections. Safe free-text fields are changed automatically after
 * the notice period (with Undo); fields that use fixed pick-lists on the site
 * or that identify the member come to the admin with the change pre-filled.
 */
const AUTO_FIELDS = {
  dob: { path: "basic.dob", label: "Date of birth" },
  fullName: { path: "basic.fullName", label: "Name" },
  gothra: { path: "basic.gothra", label: "Gothra" },
  subCaste: { path: "basic.subCaste", label: "Sub-caste" },
  workCity: { path: "personal.workCity", label: "Work city" },
};

/** Checks and converts one requested value; returns null when it isn't safe to apply. */
export const cleanChange = (field, value) => {
  const v = String(value ?? "").trim();
  if (!AUTO_FIELDS[field] || !v) return null;
  if (field === "dob") {
    const d = parseFloatingDate(v);
    return d && ageInYears(d) >= 18 && ageInYears(d) <= 100 ? d : null;
  }
  if (field === "fullName") return v.length >= 2 && v.length <= 60 && !/[0-9@<>]/.test(v) ? v : null;
  return v.length <= 60 && !/[<>@]/.test(v) ? v : null;
};

const showValue = (field, value) =>
  value instanceof Date || field === "dob" ? new Date(value).toISOString().slice(0, 10) : String(value ?? "–");

const handleProfileChange = async (config, doc, mail, t, ref, who, delay) => {
  // Same identity rule as verification: the sender owns the account, or the mail's mobile + email match it.
  const email = String(t.email || "").toLowerCase().trim();
  const mobile = normalizeMobile(t.mobile);
  let user = await User.findOne({ "basic.email": mail.from.email });
  if (!user && mobile.length === 10) {
    const byMobile = await User.findOne({ "basic.mobile": { $regex: `${mobile}$` } });
    if (byMobile && [mail.from.email, email].includes(String(byMobile.basic.email).toLowerCase())) user = byMobile;
  }
  const requested = t.changes ?? [];
  if (!user) {
    doc.needsTeam = true;
    await propose("support", {
      type: "support.reply",
      status: "needs_you",
      title: `Profile change from ${who}: can't match the account`,
      reason: `${t.summary} Requested: ${requested.map((c) => `${c.field} → ${c.value}`).join(", ") || "unclear"}.`,
      effect: "Waits for you. Ask for the registered mobile and email, or change it by hand in Members.",
      payload: { to: mail.from.email, subject: mail.subject, inReplyTo: mail.messageId, draft: await draftReply(config, mail, "Ask them to reply with the mobile number and email they registered with, so we can update their profile.") },
      ref,
    });
    return;
  }
  doc.matchedUser = user._id;
  const auto = [];
  const manual = [];
  for (const c of requested) {
    const value = cleanChange(c.field, c.value);
    if (value != null) {
      auto.push({ field: c.field, path: AUTO_FIELDS[c.field].path, label: AUTO_FIELDS[c.field].label, value: showValue(c.field, value), from: showValue(c.field, user.get(AUTO_FIELDS[c.field].path)) });
    } else {
      manual.push(c);
    }
  }
  const member = `${user.basic.fullName} (${user.basic.uniqueId ?? user.basic.email})`;
  if (auto.length) {
    doc.draft = await draftReply(config, mail, `Confirm we have updated their profile: ${auto.map((a) => `${a.label} is now ${a.value}`).join("; ")}.${manual.length ? " Say the other change they asked for will be done by the team shortly." : ""}`);
    await propose("support", {
      type: "support.profile_change",
      title: `Update ${member}: ${auto.map((a) => `${a.label} → ${a.value}`).join(", ")}`,
      reason: `${t.summary} Sent from the account's own email${mail.from.email === user.basic.email ? "" : " details (mobile + email match)"}.`,
      effect: `Changes ${auto.map((a) => `${a.label} ${a.from} → ${a.value}`).join("; ")} and replies in ${t.language}. Undo restores the old values.`,
      payload: { userId: String(user._id), changes: auto, to: mail.from.email, subject: mail.subject, inReplyTo: mail.messageId, draft: doc.draft },
      ref,
      runAt: hoursFromNow(delay),
    });
  }
  if (manual.length || !requested.length) {
    doc.needsTeam = true;
    await propose("support", {
      type: "support.reply",
      status: "needs_you",
      title: `Profile change for ${member} needs you`,
      reason: `${t.summary} Change by hand in Members: ${manual.map((c) => `${c.field} → ${c.value}`).join(", ") || "request unclear"}. These fields use fixed choices on the site or identify the member, so the agent doesn't change them.`,
      effect: "Waits for you. After changing it in Members, approve to send the reply.",
      payload: {
        to: mail.from.email,
        subject: mail.subject,
        inReplyTo: mail.messageId,
        draft: await draftReply(config, mail, `Confirm we have updated their profile as asked (${manual.map((c) => `${c.field}: ${c.value}`).join("; ") || "their request"}).`),
      },
      ref: { kind: "mail-manual", id: String(doc._id) },
    });
  }
};

const sendDraft = async (action) => {
  const p = action.payload;
  if (!p.draft?.trim()) throw new Error("The reply is empty");
  const r = await sendMail({ to: p.to, subject: p.subject, text: p.draft, inReplyTo: p.inReplyTo });
  if (action.ref?.id) await OpsMail.updateOne({ _id: action.ref.id }, { status: "replied" });
  return r;
};

handle("support.reply", sendDraft);
handle("support.refund", sendDraft);

handle("support.profile_change", async (action) => {
  const user = await User.findById(action.payload.userId);
  if (!user) throw new Error("The account no longer exists");
  const previous = [];
  for (const c of action.payload.changes) {
    const value = cleanChange(c.field, c.value);
    if (value == null) throw new Error(`${c.label} "${c.value}" isn't a valid value`);
    previous.push({ path: c.path, value: user.get(c.path) ?? null });
    user.set(c.path, value);
  }
  await user.save();
  await sendDraft(action);
  return { userId: String(user._id), previous };
});

handleUndo("support.profile_change", async (action) => {
  const user = await User.findById(action.payload.userId);
  if (!user) throw new Error("The account no longer exists");
  for (const p of action.result?.previous ?? []) user.set(p.path, p.value);
  await user.save();
});

handle("support.verify", async (action) => {
  const user = await User.findById(action.payload.userId);
  if (!user) throw new Error("The account no longer exists");
  if (!user.isVerified) {
    user.isVerified = true;
    await user.save();
    notify({
      to: [{ email: user.basic.email }],
      template_id: "profile_verified_3",
      variables: { userName: user.basic.fullName, email: user.basic.email, mobile: user.basic.mobile },
    });
  }
  await sendDraft(action);
  return { verified: true, userId: String(user._id) };
});
