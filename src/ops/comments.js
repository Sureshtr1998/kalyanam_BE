import { OpsComment, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { handle, hoursFromNow, propose } from "./actions.js";
import { deleteComment, fetchIgComments, fetchPageComments, hideComment, igConfigured, replyToComment } from "./meta.js";

/*
 * Facebook Page and Instagram comments. New comments are sorted in one
 * cheap call; hate and spam are hidden at once and deleted after the
 * configured hours (they can be restored until then); questions and praise
 * get a short reply in the commenter's language straight away.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "language", "reply"],
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: ["hate", "spam", "question", "praise", "other"] },
          language: { type: "string" },
          reply: { type: "string", description: "Reply for question/praise, empty otherwise" },
        },
      },
    },
  },
};

const system = (brief) => `You moderate comments on the Facebook Page and Instagram of Seetha Rama Kalyana, an Indian matrimony service.
${brief}
Categories: hate, spam (links, scams, ads, bots), question, praise, other.
The owner's rule: "hate" covers abuse, slurs, caste/religion hate, harassment and threats, AND any negative remark about the service or brand, in any language, e.g. "useless app", "fake", "scam", "waste of money", "I paid 351 no use", "no matches", "don't join". These are hidden and deleted, never answered in public.
A neutral question that only asks something (e.g. "how do I get a refund?") is "question", not hate.
For question and praise write a reply under 40 words in exactly the commenter's language and script.
Never discuss refunds or anyone's personal details in public; move those to email.
When someone shows interest ("interested", "details", "how to join", "price?", "is it real?"), answer briefly and invite them to register on the page in their language: Kannada seetharamakalyana.in/kn, Telugu seetharamakalyana.in/te, Tamil seetharamakalyana.in/ta, Hindi seetharamakalyana.in/hi, English seetharamakalyana.in. On Facebook write it as a full link with ?p=fc at the end (e.g. https://www.seetharamakalyana.in/kn?p=fc); on Instagram links can't be clicked, so give the short address and say "link in bio". Membership is ₹351 a year (pricing page: add /pricing to the language page).`;

export const runCommentsCycle = async () => {
  const config = await getConfig();
  const lists = [await fetchPageComments()];
  if (igConfigured()) lists.push(await fetchIgComments());
  const all = lists.flat().filter((c) => !c.ours && c.text.trim() && Date.now() - c.createdAt.getTime() < 7 * 86400000);
  const known = new Set((await OpsComment.find({ commentId: { $in: all.map((c) => c.commentId) } }).select("commentId").lean()).map((c) => c.commentId));
  const fresh = all.filter((c) => !known.has(c.commentId)).slice(0, 40);
  if (!fresh.length) return 0;

  const { items } = await ask({
    task: "comments.triage",
    tier: "sort",
    system: system(config.brief),
    prompt: fresh.map((c) => `id=${c.commentId} [${c.platform}] ${c.author}: ${c.text.slice(0, 500)}`).join("\n"),
    schema: SCHEMA,
    maxTokens: 3000,
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  for (const c of fresh) {
    const t = byId.get(c.commentId) ?? { category: "other", language: "", reply: "" };
    await OpsComment.create({ ...c, category: t.category, language: t.language, reply: t.reply });
    const ref = { kind: "comment", id: c.commentId };
    const where = c.platform === "instagram" ? "Instagram" : "Facebook";
    if ((t.category === "hate" || t.category === "spam") && !c.hidden) {
      // A paying member complaining in public is hidden too, but the card says so, so you can follow up privately.
      const paid = t.category === "hate" && /(paid|pay|payment|351|refund|money|₹|rs\.?\s?\d)/i.test(c.text);
      await propose("comments", {
        type: "comments.hide",
        priority: paid ? "urgent" : "normal",
        title: `Hide ${t.category} comment by ${c.author} (${where})${paid ? ": complained about paying" : ""}`,
        reason: `"${c.text.slice(0, 200)}"${paid ? " Check Members for this name and reach out by email or WhatsApp if they are a paid member." : ""}`,
        effect: `Hidden now, deleted after ${config.limits.commentDeleteHours} h unless you cancel.`,
        payload: { platform: c.platform, commentId: c.commentId, text: c.text },
        ref,
        runAt: new Date(),
      });
    } else if ((t.category === "question" || t.category === "praise") && t.reply) {
      await propose("comments", {
        type: "comments.reply",
        title: `Reply to ${c.author} (${where})`,
        reason: `"${c.text.slice(0, 160)}"`,
        effect: `Posts: "${t.reply}"`,
        payload: { platform: c.platform, commentId: c.commentId, reply: t.reply },
        ref,
        runAt: new Date(),
      });
    }
  }
  return fresh.length;
};

handle("comments.hide", async (action) => {
  const { platform, commentId } = action.payload;
  await hideComment(platform, commentId);
  await OpsComment.updateOne({ commentId }, { status: "hidden" });
  const hours = (await getConfig()).limits.commentDeleteHours;
  // Same card: hidden now, deleted later unless cancelled.
  return {
    hidden: true,
    next: {
      type: "comments.delete",
      title: action.title.replace(/^Hide /, "Delete hidden "),
      effect: `Hidden now. Deletes it for good in ${hours} h. Cancel to keep it hidden instead.`,
      runAt: hoursFromNow(hours),
    },
  };
});

handle("comments.delete", async (action) => {
  await deleteComment(action.payload.commentId);
  await OpsComment.updateOne({ commentId: action.payload.commentId }, { status: "deleted" });
  return { deleted: true };
});

handle("comments.reply", async (action) => {
  const { platform, commentId, reply } = action.payload;
  const r = await replyToComment(platform, commentId, reply);
  await OpsComment.updateOne({ commentId }, { status: "replied", reply });
  return { replyId: r.id };
});
