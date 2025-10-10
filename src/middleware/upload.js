import multer from 'multer';

const storage = multer.memoryStorage(); // store in memory temporarily
const upload = multer({
    storage,
    limits: { fileSize: 1000 * 1024 }, // max 1 MB
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.match(/\/(jpeg|jpg|png)$/)) {
            cb(new Error('Only .png, .jpg and .jpeg format allowed!'));
        } else {
            cb(null, true);
        }
    },
});

export default upload;
