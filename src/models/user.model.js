const mongoose = require("mongoose");

const BirthLocationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: null,
      trim: true,
    },
    placeId: {
      type: String,
      default: null,
      trim: true,
    },
    city: {
      type: String,
      default: null,
      trim: true,
    },
    district: {
      type: String,
      default: null,
      trim: true,
    },
    state: {
      type: String,
      default: null,
      trim: true,
    },
    country: {
      type: String,
      default: null,
      trim: true,
    },
    latitude: {
      type: Number,
      default: null,
    },
    longitude: {
      type: Number,
      default: null,
    },
    timezone: {
      type: String,
      default: null,
      trim: true,
    },
  },
  { _id: false, timestamps: true }
);

const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: null,
      trim: true,
    },

    uniqueId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    firstname: {
      type: String,
      default: null,
      trim: true,
    },

    middlename: {
      type: String,
      default: null,
      trim: true,
    },

    lastname: {
      type: String,
      default: null,
      trim: true,
    },

    gender: {
      type: String,
      enum: ["male", "female", "other"],
      default: null,
      lowercase: true,
      trim: true,
    },

    dateofbirth: {
      type: Date,
      default: null,
    },

    timeofbirth: {
      type: String,
      default: null,
      trim: true,
    },

    // 1-to-1 Birth Location sub-model
    birthLocation: {
      type: BirthLocationSchema,
      default: () => ({}),
    },

    // Legacy fields kept for backward compatibility
    placeofbirth: {
      type: String,
      default: null,
      trim: true,
    },

    city: {
      type: String,
      default: null,
      trim: true,
    },

    state: {
      type: String,
      default: null,
      trim: true,
    },

    country: {
      type: String,
      default: null,
      trim: true,
    },

    address: {
      type: String,
      default: null,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    email: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
      sparse: true,
    },

    role: {
      type: String,
      enum: ["user", "astrologer", "admin"],
      default: "user",
    },

    profileImage: {
      type: String,
      default: null,
    },

    isProfileCompleted: {
      type: Boolean,
      default: false,
    },

    userLogin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserLogin",
      default: null,
    },

    walletBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

UserSchema.virtual("avatar").get(function () {
  return this.profileImage;
});

UserSchema.pre("save", async function () {
  if (!this.uniqueId) {
    const randomDigits = Math.floor(100000 + Math.random() * 900000);
    this.uniqueId = `UB${randomDigits}`;
  }

  // Keep legacy placeofbirth in sync with birthLocation.name if provided
  if (this.birthLocation && this.birthLocation.name) {
    this.placeofbirth = this.birthLocation.name;
    if (this.birthLocation.city) this.city = this.birthLocation.city;
    if (this.birthLocation.state) this.state = this.birthLocation.state;
    if (this.birthLocation.country) this.country = this.birthLocation.country;
  } else if (this.placeofbirth && (!this.birthLocation || !this.birthLocation.name)) {
    this.birthLocation = {
      name: this.placeofbirth,
      city: this.city || null,
      state: this.state || null,
      country: this.country || null,
    };
  }

  const isDefaultPic =
    !this.profileImage ||
    this.profileImage.includes("user_female_pic") ||
    this.profileImage.includes("user_male_pic") ||
    this.profileImage.includes("astro_female_pic") ||
    this.profileImage.includes("astro_male_pic");

  if (isDefaultPic) {
    const { getDefaultProfilePic } = require("../services/cloudinary.service");
    this.profileImage = getDefaultProfilePic(this._id, this.role, this.gender);
  }
});

module.exports = mongoose.model("User", UserSchema);