import { Router } from "express";
import dbConnect from "../../utils/dbConnect.js";
import { auth } from "../../middleware/auth.js";
import {
  getAstroApiData,
  getAstrologyDelay,
} from "../../utils/astrology/astroHelper.js";
import getPlanetPositions, { getAshtakootScore } from "../../config/astroApi.js";
import { generateAstroInsights } from "../../config/openAi.js";
import User from "../../models/User.js";
import { publishQStash } from "../../config/upStash.js";
import { SUPPORT_EMAIL, isTestPayer } from "../../utils/constants.js";
import { notify } from "../../config/msg91Email.js";
import {
  HttpError,
  resolvePaidOrder,
  saveOrder,
  sendHttpError,
} from "../../utils/payments.js";

const router = Router();

/** Fulfils a paid astrology order (browser after checkout, or webhook fallback). */
router.post("/astro-data", auth, async (req, res) => {
  try {
    await dbConnect();
    const { record, orderId, paymentId } = await resolvePaidOrder(req, "astro");
    // @ts-ignore
    const currentUser = req.user;
    if (record.email !== currentUser.basic.email) {
      throw new HttpError(403, "This payment belongs to a different account");
    }

    const astro = record.astro;
    const result = await User.updateOne(
      { _id: currentUser._id, "transactions.orderId": { $ne: orderId } },
      {
        $push: {
          astrology: {
            $each: [
              {
                ...astro,
                dob: new Date(astro.dob),
                mDob: astro.mDob ? new Date(astro.mDob) : undefined,
                status: "pending",
              },
            ],
            $position: 0,
          },
          transactions: {
            $each: [
              {
                orderId,
                paymentId,
                amountPaid: record.amountCharged,
                note: record.note,
              },
            ],
            $position: 0,
          },
        },
      }
    );

    if (result.modifiedCount) {
      await saveOrder(orderId, { ...record, fulfilled: true, paymentId });
      // Admins / test payers get the reading right away for testing: the job
      // starts immediately and generation itself takes ~10–20s.
      const delay =
        currentUser.isAdmin || isTestPayer(record.email)
          ? "0s"
          : getAstrologyDelay();
      try {
        await publishQStash(
          "astrology",
          { uniqueId: astro.uId, email: record.email },
          delay
        );
      } catch (err) {
        console.error("Failed to schedule astrology job:", err);
        notify({
          to: [{ email: SUPPORT_EMAIL }],
          template_id: "user_register_2",
          variables: {
            note: "Astrology scheduling failed",
            payload: `${record.email} | ${astro.uId} | ${orderId}`,
          },
        });
      }
    }

    const data = await User.findById(currentUser._id)
      .select("-basic.password")
      .lean();
    return res.status(201).json({
      msg: "Your request has been received. We'll email you when the reading is ready.",
      data,
    });
  } catch (err) {
    return sendHttpError(res, err);
  }
});

router.get("/astro-data", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const userId = req.user.id;
    const user = await User.findById(userId).select("-basic.password").lean();

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    return res.status(200).json({
      astrology: user.astrology || [],
      currentUser: user,
    });
  } catch (err) {
    console.error(err, "Astro fetch error");
    res.status(500).json({ error: "Server error" });
  }
});

/** Called by QStash after the delay to generate the reading. */
router.post("/astrology", auth, async (req, res) => {
  try {
    const { uniqueId } = req.body;
    await dbConnect();

    // @ts-ignore
    const currentUserId = req.user.id;
    const user = await User.findById(currentUserId);

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    const astroEntry = user.astrology.find((a) => a.uId === uniqueId);

    if (!astroEntry) {
      return res
        .status(404)
        .json({ msg: "Astrology record not found for this uId" });
    }
    if (astroEntry.status === "completed") {
      // 2xx so QStash stops retrying.
      return res.status(200).json({ msg: "Astrology already updated for this" });
    }
    const {
      consultationMode,
      dob,
      place,
      gender,
      query,
      mDob,
      mPlace,
      mGender,
      lat,
      lng,
      mLat,
      mLng,
    } = astroEntry;

    let aiResponse;
    try {
      const user1 = await getAstroApiData(dob, place, { lat, lng });
      const kundli1 = await getPlanetPositions(user1);

      let kundli2;
      let guna;
      if (mPlace) {
        const user2 = await getAstroApiData(mDob, mPlace, { lat: mLat, lng: mLng });
        kundli2 = await getPlanetPositions(user2);
        // Guna Milan is bride (female) vs groom (male).
        const firstIsBride = gender === "Female" || mGender !== "Female";
        guna = await getAshtakootScore(
          firstIsBride ? user1 : user2,
          firstIsBride ? user2 : user1
        );
      }

      aiResponse = await generateAstroInsights({
        kundli1,
        kundli2,
        guna,
        query,
        gender1: gender,
        gender2: mGender,
        consultationMode,
      });
    } catch (err) {
      // A bad place name will never succeed on retry: flag it for support.
      if (err instanceof HttpError) {
        astroEntry.status = "failed";
        astroEntry.aiResponse = err.message;
        await user.save();
        notify({
          to: [{ email: SUPPORT_EMAIL }],
          template_id: "user_register_2",
          variables: {
            note: "Astrology failed",
            payload: `${user.basic.email} | ${uniqueId} | ${err.message}`,
          },
        });
        return res.status(200).json({ msg: "Marked as failed" });
      }
      throw err;
    }

    astroEntry.status = "completed";
    astroEntry.aiResponse = aiResponse;

    await user.save();
    notify({
      to: [{ email: user.basic.email }],
      template_id: "astro_insights", // MSG91 Template ID
      variables: {
        username: user.basic.fullName || "",
        consultationMode,
      },
    });
    return res.status(200).json({ msg: "Astrology updated" });
  } catch (err) {
    console.error(err, "Astro AI error");
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
