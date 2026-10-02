const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
    {
        from: { type: String, enum: ["user", "admin", "system"], required: true },
        authorName: { type: String, default: "" },
        authorAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
        text: { type: String, required: true, maxlength: 2000 },
        internal: { type: Boolean, default: false }, // staff-only note, never shown to the customer
        createdAt: { type: Date, default: Date.now }
    },
    { _id: true }
);

const CATEGORIES = [
    "money_deducted_not_added", // paid but wallet not credited
    "payment_failed",           // payment failed / stuck
    "wrong_amount",             // charged or credited a wrong amount
    "session_billing",          // chat / call charge looks wrong
    "bonus_missing",            // promised bonus not received
    "refund_request",
    "other"
];

// A customer complaint about one transaction.
const SupportTicketSchema = new mongoose.Schema(
    {
        number: { type: String, required: true, unique: true }, // MJ-000123
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        // The transaction the complaint is about, copied at the time so it stays readable if the record changes
        ref: {
            type: { type: String, enum: ["payment", "chat", "call"], required: true },
            id: { type: String, required: true, index: true },
            title: { type: String, default: "" },
            amount: { type: Number, default: 0 },
            status: { type: String, default: "" },
            transactionId: { type: String, default: "" },
            date: { type: Date, default: null }
        },

        category: { type: String, enum: CATEGORIES, required: true },
        status: { type: String, enum: ["open", "in_progress", "resolved", "rejected"], default: "open", index: true },
        priority: { type: String, enum: ["normal", "high"], default: "normal", index: true },

        messages: { type: [MessageSchema], default: [] },

        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null, index: true },
        resolution: { type: String, default: "", maxlength: 1000 },
        resolvedAt: { type: Date, default: null },
        resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },

        lastActivityAt: { type: Date, default: Date.now, index: true },
        userUnread: { type: Boolean, default: false },   // staff replied, customer has not seen it
        adminUnread: { type: Boolean, default: true }    // customer wrote, staff has not seen it
    },
    { timestamps: true }
);

// A customer can have only one unresolved complaint per transaction
SupportTicketSchema.index(
    { user: 1, "ref.type": 1, "ref.id": 1 },
    { unique: true, partialFilterExpression: { status: { $in: ["open", "in_progress"] } } }
);

SupportTicketSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model("SupportTicket", SupportTicketSchema);
