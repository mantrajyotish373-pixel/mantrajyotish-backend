const express = require("express");

const router = express.Router();

const appointmentController = require("../controllers/appointment.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requirePermission } = adminMiddleware;

router.post(
    "/create",
    authMiddleware,
    appointmentController.createAppointment
);

router.get(
    "/all",
    authMiddleware,
    requirePermission("bookings.view"),
    appointmentController.getAllAppointments
);

router.get(
    "/:id",
    authMiddleware,
    requirePermission("bookings.view"),
    appointmentController.getAppointmentById
);

router.put(
    "/update/:id",
    authMiddleware,
    requirePermission("bookings.manage"),
    appointmentController.updateAppointment
);

router.delete(
    "/delete/:id",
    authMiddleware,
    requirePermission("bookings.manage"),
    appointmentController.deleteAppointment
);

module.exports = router;