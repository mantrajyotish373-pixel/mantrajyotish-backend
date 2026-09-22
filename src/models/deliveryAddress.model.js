const mongoose = require("mongoose");

const DeliveryAddressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    alternatePhone: {
      type: String,
      default: null,
      trim: true,
    },
    addressType: {
      type: String,
      enum: ["home", "work", "other"],
      default: "home",
      lowercase: true,
    },
    flatHouseNo: {
      type: String,
      required: true,
      trim: true,
    },
    areaStreet: {
      type: String,
      required: true,
      trim: true,
    },
    landmark: {
      type: String,
      default: null,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    state: {
      type: String,
      required: true,
      trim: true,
    },
    country: {
      type: String,
      default: "India",
      trim: true,
    },
    pincode: {
      type: String,
      required: true,
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
    placeId: {
      type: String,
      default: null,
      trim: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Ensure that setting an address as default removes default flag from user's other addresses
DeliveryAddressSchema.pre("save", async function () {
  if (this.isDefault) {
    await this.constructor.updateMany(
      { user: this.user, _id: { $ne: this._id } },
      { $set: { isDefault: false } }
    );
  }
});

module.exports = mongoose.model("DeliveryAddress", DeliveryAddressSchema);
