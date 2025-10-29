import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth/index.js";

dotenv.config();

const app = express();

// Middlewares
app.use(cors());
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
