const express = require("express");

const router = express.Router();

const appointmentController = require("../controllers/appointment.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");

router.post(
    "/create",
    authMiddleware,
    appointmentController.createAppointment
);

router.get(
    "/all",
    authMiddleware,
    adminMiddleware,
    appointmentController.getAllAppointments
);

router.get(
    "/:id",
    authMiddleware,
    adminMiddleware,
    appointmentController.getAppointmentById
);

router.put(
    "/update/:id",
    authMiddleware,
    adminMiddleware,
    appointmentController.updateAppointment
);

router.delete(
    "/delete/:id",
    authMiddleware,
    adminMiddleware,
    appointmentController.deleteAppointment
);

module.exports = router;