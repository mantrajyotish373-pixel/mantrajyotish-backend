const express = require("express");

const router = express.Router();

const userController = require("../controllers/user.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requirePermission } = adminMiddleware;

// Public & Registration routes
router.post("/register", userController.registerUser);
router.post("/create", userController.registerUser);

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