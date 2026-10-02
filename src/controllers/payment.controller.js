const paymentService = require("../services/payment.service");

const createPayment = async (req, res) => {
    try {

        const payment = await paymentService.createPayment(req.body);

        return res.status(201).json({
            success: true,
            message: "Payment Created Successfully",
            data: payment
        });

    } catch (error) {

        return res.status(400).json({
            success: false,
            message: error.message
        });

    }
};

const getAllPayments = async (req, res) => {
    try {

        const payments = await paymentService.getAllPayments();

        return res.status(200).json({
            success: true,
            count: payments.length,
            data: payments
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message: error.message
        });

    }
};

const getPaymentById = async (req, res) => {
    try {

        const payment = await paymentService.getPaymentById(req.params.id);

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Payment Not Found"
            });
        }

        return res.status(200).json({
            success: true,
            data: payment
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message: error.message
        });

    }
};

const updatePayment = async (req, res) => {
    try {
        // Money that went through the gateway is read-only: its status comes from Razorpay, not from a form.
        const existing = await paymentService.getPaymentById(req.params.id);
        if (existing && existing.paymentGateway === "Razorpay") {
            return res.status(403).json({
                success: false,
                message: "Gateway payments are read-only. Use \"Re-check with Razorpay\" in Payment Logs to refresh a payment."
            });
        }

        const payment = await paymentService.updatePayment(
            req.params.id,
            req.body
        );

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Payment Not Found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Payment Updated Successfully",
            data: payment
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message: error.message
        });

    }
};

const deletePayment = async (req, res) => {
    // Payment records are the financial ledger: they are never deleted, only corrected through audited wallet adjustments.
    return res.status(403).json({
        success: false,
        message: "Payment records cannot be deleted. They are kept as a permanent financial record."
    });
};

const _deletePaymentDisabled = async (req, res) => {
    try {

        const payment = await paymentService.deletePayment(req.params.id);

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Payment Not Found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Payment Deleted Successfully"
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message: error.message
        });

    }
};

const getPaymentByTransactionId = async (req, res) => {
    try {
        const id = req.params.id;
        const payment = await paymentService.getPaymentByTransactionId(id);

        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment Not Found" });
        }

        return res.status(200).json({ success: true, data: payment });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createPayment,
    getAllPayments,
    getPaymentById,
    updatePayment,
    deletePayment,
    getPaymentByTransactionId
};