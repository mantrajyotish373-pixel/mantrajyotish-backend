const mongoose = require("mongoose");

// A role is a named permission template. Sub-admins receive a copy of its permissions
// when created and can then be customised individually.
const RoleSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, unique: true, trim: true },
        description: { type: String, default: "", trim: true },
        permissions: { type: [String], default: [] },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Role", RoleSchema);
