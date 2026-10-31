import multer from "multer";

const storage = multer.memoryStorage(); // store files in memory

const upload = multer({
  storage,
  limits: { fileSize: 1000 * 1024 }, // max 1 MB per file
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png"];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpg, jpeg, png files are allowed"));
  },
});

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (buf, sig) => buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

/** True when the bytes really are a JPEG or PNG (the mimetype is client-supplied). */
export const isImageBuffer = (buf) => startsWith(buf, JPEG) || startsWith(buf, PNG);

/** Runs after `upload.array()`: rejects files whose content isn't an image. */
export const requireImageContent = (req, res, next) => {
  const files = /** @type {Express.Multer.File[]} */ (req.files || []);
  if (files.some((f) => !isImageBuffer(f.buffer))) {
    return res.status(400).json({ success: false, msg: "Only jpg, jpeg, png files are allowed" });
  }
  return next();
};

export default upload;
