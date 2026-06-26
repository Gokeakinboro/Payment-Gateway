"use strict";
const router     = require("express").Router();
const multer     = require("multer");
const { Readable } = require("stream");
const cloudinary = require("../utils/cloudinary");

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split(".").pop().toLowerCase();
    if (!["pdf", "jpg", "jpeg", "png"].includes(ext))
      return cb(new Error("Only PDF, JPG and PNG files are allowed"));
    cb(null, true);
  },
});

router.post("/document", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ status: false, message: "No file uploaded" });

    const docType  = (req.body.doc_type || "document").replace(/[^a-z0-9_]/gi, "_");
    const publicId = docType + "_" + Date.now();

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "paylode/kyc", resource_type: "auto", public_id: publicId },
        (err, r) => err ? reject(err) : resolve(r)
      );
      Readable.from(req.file.buffer).pipe(stream);
    });

    res.json({ status: true, data: { url: result.secure_url, public_id: result.public_id } });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

module.exports = router;
