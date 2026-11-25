import mongoose, { Schema } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: true, select: false },
    institution: { type: String, trim: true, maxlength: 160, default: "" },
    bio: { type: String, trim: true, maxlength: 1000, default: "" },
    researchInterests: { type: [String], default: [] },
  },
  { timestamps: true },
);

const paperSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    uploaderName: {
      type: String,
      trim: true,
      default: "Research Desk community",
    },
    legacySource: { type: String, unique: true, sparse: true },
    hasPdf: { type: Boolean, default: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    originalName: { type: String, required: true },
    authors: { type: [String], default: [] },
    abstract: { type: String, trim: true, maxlength: 5000, default: "" },
    tags: { type: [String], default: [] },
    year: { type: Number, min: 1000, max: 3000 },
    pageCount: { type: Number, required: true },
    chunkCount: { type: Number, required: true },
    fileSize: { type: Number, required: true, default: 0 },
    storageName: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);

paperSchema.index({
  title: "text",
  originalName: "text",
  authors: "text",
  abstract: "text",
  tags: "text",
});
paperSchema.index({ year: -1, createdAt: -1 });

export const User = mongoose.models.User ?? mongoose.model("User", userSchema);
export const Paper =
  mongoose.models.Paper ?? mongoose.model("Paper", paperSchema);
