import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";

/*
 * The support inbox (GoDaddy Workspace Email). Reads over IMAP, replies over
 * SMTP from the same mailbox so replies show in its Sent folder and threads.
 * Reading never marks mail as read: the inbox looks the same in webmail.
 */

const USER = () => process.env.OPS_MAIL_USER || "contactus@seetharamakalyana.in";
export const mailConfigured = () => !!process.env.OPS_MAIL_PASSWORD;

// GoDaddy mailboxes run on Titan; either host pair may hold the mailbox, so try both.
const IMAP_HOSTS = () => [process.env.OPS_IMAP_HOST, "imap.secureserver.net", "imap.titan.email"].filter(Boolean);
const SMTP_HOSTS = () => [process.env.OPS_SMTP_HOST, "smtpout.secureserver.net", "smtp.titan.email"].filter(Boolean);
let workingImap = null;
let workingSmtp = null;

const imapClient = (host) =>
  new ImapFlow({
    host,
    port: 993,
    secure: true,
    auth: { user: USER(), pass: process.env.OPS_MAIL_PASSWORD },
    logger: false,
    socketTimeout: 20000,
  });

/** A logged-in IMAP client on the first host that accepts the password. */
const connectImap = async () => {
  const hosts = workingImap ? [workingImap, ...IMAP_HOSTS().filter((h) => h !== workingImap)] : IMAP_HOSTS();
  let lastErr;
  for (const host of [...new Set(hosts)]) {
    const client = imapClient(host);
    try {
      await client.connect();
      workingImap = host;
      return client;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Mailbox login failed on ${IMAP_HOSTS().join(", ")}: ${lastErr?.responseText || lastErr?.message}`);
};

/**
 * Mail that arrived after `lastUid` (at most `max`). On the first run only
 * the last 3 days are read, so old mail isn't answered.
 */
export const fetchNewMail = async (lastUid, max = 15) => {
  const client = await connectImap();
  const out = [];
  const lock = await client.getMailboxLock("INBOX");
  try {
    let uids;
    if (lastUid > 0) {
      uids = (await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || [];
      uids = uids.filter((u) => u > lastUid);
    } else {
      uids = (await client.search({ since: new Date(Date.now() - 3 * 86400000) }, { uid: true })) || [];
    }
    uids = uids.sort((a, b) => a - b).slice(0, max);
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      if (!msg?.source) continue;
      const parsed = await simpleParser(msg.source);
      const from = parsed.from?.value?.[0] ?? {};
      out.push({
        uid,
        messageId: parsed.messageId,
        from: { email: String(from.address || "").toLowerCase(), name: from.name || "" },
        subject: parsed.subject || "",
        text: String(parsed.text || "").slice(0, 8000),
        receivedAt: parsed.date || new Date(),
        headers: {
          listUnsubscribe: !!parsed.headers.get("list-unsubscribe"),
          autoSubmitted: String(parsed.headers.get("auto-submitted") || ""),
          precedence: String(parsed.headers.get("precedence") || ""),
        },
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
};

const smtpFor = (host) =>
  nodemailer.createTransport({ host, port: 465, secure: true, auth: { user: USER(), pass: process.env.OPS_MAIL_PASSWORD } });

/** Sends a reply from the support mailbox, threaded under the original. */
export const sendMail = async ({ to, subject, text, inReplyTo }) => {
  const hosts = workingSmtp ? [workingSmtp, ...SMTP_HOSTS()] : SMTP_HOSTS();
  let lastErr;
  for (const host of [...new Set(hosts)]) {
    try {
      const r = await send(smtpFor(host), { to, subject, text, inReplyTo });
      workingSmtp = host;
      return r;
    } catch (err) {
      lastErr = err;
      // Only an authentication or connection failure is worth trying the other host for.
      if (!/auth|ECONN|ETIMEDOUT|ENOTFOUND|535|534/i.test(`${err.code} ${err.message}`)) throw err;
    }
  }
  throw lastErr;
};

const send = async (transport, { to, subject, text, inReplyTo }) => {
  const message = {
    from: { name: "Seetha Rama Kalyana Support", address: USER() },
    to,
    // "Re:" only on a reply to their mail; alerts and reminders keep their own subject.
    subject: !inReplyTo || /^re:/i.test(subject || "") ? subject || "Seetha Rama Kalyana" : `Re: ${subject || "your message"}`,
    text,
    date: new Date(),
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  };
  // Built once, so the copy in Sent is byte-for-byte what was sent.
  const raw = await new MailComposer(message).compile().build();
  const info = await transport.sendMail({ envelope: { from: USER(), to }, raw });
  await saveToSent(raw);
  return { messageId: info.messageId };
};

/**
 * SMTP doesn't keep a copy, so the sent mail is also put in the mailbox's
 * Sent folder over IMAP: replies show in Titan webmail like any other.
 * Never throws: the mail has already gone out.
 */
export const saveToSent = async (raw) => {
  let client;
  try {
    client = await connectImap();
    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === "\\Sent") ?? boxes.find((b) => /^(inbox[./])?sent( items| mail)?$/i.test(b.path));
    await client.append(sent?.path ?? "Sent", raw, ["\\Seen"]);
  } catch (err) {
    console.error("[ops] save to Sent", err.message);
  } finally {
    await client?.logout().catch(() => {});
  }
};

/** Checks the login works (used by the Settings "Test" button). */
export const testMailLogin = async () => {
  const client = await connectImap();
  const status = await client.status("INBOX", { messages: true, unseen: true });
  await client.logout().catch(() => {});
  return { ...status, host: workingImap };
};
