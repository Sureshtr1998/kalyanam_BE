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

export default upload;
