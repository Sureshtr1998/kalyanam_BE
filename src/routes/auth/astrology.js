import { Router } from "express";
import dbConnect from "../../utils/dbConnect.js";
import { auth } from "../../middleware/auth.js";
import {
  getAstroApiData,
  getAstrologyDelay,
} from "../../utils/astrology/astroHelper.js";
import getPlanetPositions from "../../config/astroApi.js";
import { generateAstroInsights } from "../../config/openAi.js";
import User from "../../models/User.js";
import { nanoid } from "nanoid";
import upStash, { publishQStash } from "../../config/upStash.js";
import { PENDING_PAYMENT } from "../../utils/constants.js";
import { isTransactionExists } from "../../utils/utils.js";
import sendEmail from "../../config/msg91Email.js";

const router = Router();

router.post("/astro-data", auth, async (req, res) => {
  try {
    await dbConnect();

    const {
      consultationMode,
      name,
      dob,
      place,
      gender,
      query,
      mName,
      mDob,
      mPlace,
      mGender,
      //Transactions
      orderId,
      amount,
      note,
      paymentId,
    } = req.body;

    if (!name || !dob || !place || !gender) {
      return res
        .status(400)
        .json({ error: "Name, dob, gender and place are required" });
    }

    // @ts-ignore
    const currentUserId = req.user.id;
    const currentUser = await User.findById(currentUserId);

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    const exists = isTransactionExists(currentUser.transactions, orderId);
    if (exists) {
      return res.status(200).json({
        success: false,
        msg: "Transaction data already exists",
      });
    }

    const uniqueId = nanoid();
    const newAstrologyEntry = {
      name,
      mName,
      uId: uniqueId,
      dob,
      mDob,
      place,
      mPlace,
      gender,
      mGender,
      consultationMode,
      query,
      status: "pending",
    };

    currentUser.astrology.unshift(newAstrologyEntry);

    const email = currentUser.basic.email;
    currentUser.transactions.unshift({
      orderId,
      paymentId,
      amountPaid: amount,
      note,
    });
    await currentUser.save();
    await upStash.del(`${PENDING_PAYMENT}${email}`);
    const delay =
      currentUser.basic.fullName === "Suresh TR" ? "1m" : getAstrologyDelay();

    await publishQStash("astrology", { uniqueId, email }, delay);

    return res.status(201).json({
      msg: "Astrology data saved successfully",
      data: currentUser,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/astro-data", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const userId = req.user.id;
    const user = await User.findById(userId).lean();

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (!user.astrology) {
      return res.status(200).json({
        currentUser: user,
      });
    }

    return res.status(200).json({
      astrology: user.astrology,
      currentUser: user,
    });
  } catch (err) {
    console.error(err, "Astro fetch error");
    res.status(500).json({ error: "Server error" });
  }
});

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
      //Send Report Email if fails
      return res
        .status(404)
        .json({ msg: "Astrology record not found for this uId" });
    }
    if (astroEntry.status === "completed") {
      return res
        .status(404)
        .json({ msg: "Astrology already updated for this" });
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
    } = astroEntry;
    const user1 = await getAstroApiData(dob, place);
    const kundli1 = await getPlanetPositions(user1);

    let user2;
    let kundli2;
    if (mPlace) {
      user2 = await getAstroApiData(mDob, mPlace);
      kundli2 = await getPlanetPositions(user2);
    }

    const aiResponse = await generateAstroInsights({
      kundli1,
      kundli2,
      query,
      gender1: gender,
      gender2: mGender,
      consultationMode,
    });

    astroEntry.status = "completed";
    astroEntry.aiResponse = aiResponse;

    await user.save();
    await sendEmail({
      to: [{ email: user.basic.email }],
      template_id: "astro_insights", // MSG91 Template ID
      variables: {
        username: user.basic.fullName || "",
        consultationMode,
      },
    });
    return res.status(200);
  } catch (err) {
    console.error(err, "Astro AI error");
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
