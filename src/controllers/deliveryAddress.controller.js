const DeliveryAddress = require("../models/deliveryAddress.model");

// 1. ADD / CREATE NEW DELIVERY ADDRESS
const addAddress = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const {
      name,
      phone,
      alternatePhone,
      addressType,
      flatHouseNo,
      areaStreet,
      landmark,
      city,
      state,
      country,
      pincode,
      latitude,
      longitude,
      placeId,
      isDefault,
    } = req.body;

    if (!name || !phone || !flatHouseNo || !areaStreet || !city || !state || !pincode) {
      return res.status(400).json({
        success: false,
        message: "Missing required delivery address fields (name, phone, flatHouseNo, areaStreet, city, state, pincode)",
      });
    }

    // Check if this is user's first address, make it default if so
    const existingCount = await DeliveryAddress.countDocuments({ user: userId });
    const shouldBeDefault = existingCount === 0 ? true : Boolean(isDefault);

    const newAddress = await DeliveryAddress.create({
      user: userId,
      name,
      phone,
      alternatePhone: alternatePhone || null,
      addressType: addressType || "home",
      flatHouseNo,
      areaStreet,
      landmark: landmark || null,
      city,
      state,
      country: country || "India",
      pincode,
      latitude: latitude !== undefined ? latitude : null,
      longitude: longitude !== undefined ? longitude : null,
      placeId: placeId || null,
      isDefault: shouldBeDefault,
    });

    return res.status(201).json({
      success: true,
      message: "Delivery address added successfully",
      data: newAddress,
    });
  } catch (error) {
    next(error);
  }
};

// 2. GET ALL DELIVERY ADDRESSES FOR LOGGED-IN USER
const getUserAddresses = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const addresses = await DeliveryAddress.find({ user: userId }).sort({ isDefault: -1, createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: addresses.length,
      data: addresses,
    });
  } catch (error) {
    next(error);
  }
};

// 3. GET SINGLE ADDRESS BY ID
const getAddressById = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const address = await DeliveryAddress.findOne({ _id: id, user: userId });
    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Delivery address not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: address,
    });
  } catch (error) {
    next(error);
  }
};

// 4. UPDATE ADDRESS
const updateAddress = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const address = await DeliveryAddress.findOne({ _id: id, user: userId });
    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Delivery address not found",
      });
    }

    Object.assign(address, req.body);
    await address.save();

    return res.status(200).json({
      success: true,
      message: "Delivery address updated successfully",
      data: address,
    });
  } catch (error) {
    next(error);
  }
};

// 5. DELETE ADDRESS
const deleteAddress = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const address = await DeliveryAddress.findOneAndDelete({ _id: id, user: userId });
    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Delivery address not found",
      });
    }

    // If deleted address was default, set the latest remaining address as default
    if (address.isDefault) {
      const remainingAddress = await DeliveryAddress.findOne({ user: userId }).sort({ createdAt: -1 });
      if (remainingAddress) {
        remainingAddress.isDefault = true;
        await remainingAddress.save();
      }
    }

    return res.status(200).json({
      success: true,
      message: "Delivery address deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  addAddress,
  getUserAddresses,
  getAddressById,
  updateAddress,
  deleteAddress,
};
