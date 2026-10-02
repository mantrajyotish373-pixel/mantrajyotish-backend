const express = require("express");

const router = express.Router();

const userController = require("../controllers/user.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requirePermission } = adminMiddleware;

// Customers are only ever created by a verified OTP login (POST /api/auth/verify-otp).
// This route is for staff adding a user by hand; it is never open to the public.
router.post("/create", authMiddleware, requirePermission("users.edit"), userController.registerUser);

// Admin & Listing routes
router.get("/all", authMiddleware, requirePermission("users.view"), userController.getAllUsers);
router.get("/profile", authMiddleware, userController.getProfile);
router.get("/:id", authMiddleware, requirePermission("users.view"), userController.getUserById);

// Update & Delete routes
router.put("/profile", authMiddleware, userController.updateProfile);
router.put("/update/:id", authMiddleware, requirePermission("users.edit"), userController.updateProfile);
router.put("/:id", authMiddleware, requirePermission("users.edit"), userController.updateProfile);
router.delete("/delete/:id", authMiddleware, requirePermission("users.delete"), userController.deleteUser);
router.delete("/:id", authMiddleware, requirePermission("users.delete"), userController.deleteUser);

module.exports = router;