import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth/index.js";
import dbConnect from "./utils/dbConnect.js";
dotenv.config();

const app = express();

// http://localhost:5173/
const corsOptions = {
  origin: ["https://www.seetharamakalyana.in"],
  methods: ["GET", "POST", "PUT", "DELETE"],
};

// Middlewares
// app.use(cors());
app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: true }));

app.use(express.json());

app.use(async (req, res, next) => {
  try {
    await dbConnect();
    next();
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    res.status(500).send("Database connection error");
  }
});

// Routes
app.use("/api", authRoutes);

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

export default app;
