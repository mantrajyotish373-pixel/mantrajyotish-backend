const mongoose = require("mongoose");

const ChatMessageSchema = new mongoose.Schema(
    {
        session: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ChatSession",
            required: true
        },

        senderId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true
        },

        senderType: {
            type: String,
            enum: ["USER", "ASTROLOGER"],
            required: true
        },

        messageType: {
            type: String,
            enum: ["text", "image", "kundli"],
            default: "text"
        },

        text: {
            type: String,
            trim: true,
            default: ""
        },

        mediaUrl: {
            type: String,
            default: null
        },

        isRead: {
            type: Boolean,
            default: false
        },

        clientMessageId: {
            type: String,
            trim: true,
            default: null,
            index: true
        }
    },
    {
        timestamps: true
    }
);

ChatMessageSchema.index({ session: 1, clientMessageId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("ChatMessage", ChatMessageSchema);
