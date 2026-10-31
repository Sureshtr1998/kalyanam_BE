import mongoose from "mongoose";

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function dbConnect() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGO_URI, {
      bufferCommands: false, // avoid buffering when connection fails
      serverSelectionTimeoutMS: 10000, // wait max 10s
      maxPoolSize: 5,
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    // Don't keep a rejected promise around, or a warm instance would fail
    // every request until it's recycled. The next request retries.
    cached.promise = null;
    throw err;
  }
  return cached.conn;
}

export default dbConnect;
