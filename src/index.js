import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth/index.js";

dotenv.config();

const app = express();

// "http://localhost:5173"
const corsOptions = {
  origin: ["https://www.seetharamakalyana.in", "https://seetharamakalyana.in"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
};

// Middlewares
app.use(cors(corsOptions));

// app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: true }));

app.use(express.json());

// Routes
app.use("/api", authRoutes);

// Connect MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected on", process.env.MONGO_URI))
  .catch((err) => console.error(err));

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

export default app;
