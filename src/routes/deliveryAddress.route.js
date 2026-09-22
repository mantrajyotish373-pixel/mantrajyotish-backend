const express = require("express");
const router = express.Router();
const {
  addAddress,
  getUserAddresses,
  getAddressById,
  updateAddress,
  deleteAddress,
} = require("../controllers/deliveryAddress.controller");
const { verifyToken } = require("../middlewares/auth.middleware");

router.use(verifyToken);

router.post("/", addAddress);
router.get("/", getUserAddresses);
router.get("/:id", getAddressById);
router.put("/:id", updateAddress);
router.delete("/:id", deleteAddress);

module.exports = router;
