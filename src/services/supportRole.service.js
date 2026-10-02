const Role = require("../models/role.model");

// A ready-made role for customer-support staff. Created once; the super admin can edit it like any other role.
const ensureSupportRole = async () => {
    try {
        if (await Role.exists({ name: "Support Agent" })) return;
        await Role.create({
            name: "Support Agent",
            description: "Handles customer complaints about transactions. Can view payments and users to investigate, but cannot change money.",
            permissions: ["support.view", "support.manage", "payments.view", "users.view"]
        });
        console.log("Created default role: Support Agent");
    } catch (e) {
        console.error("support role setup failed:", e.message);
    }
};

module.exports = { ensureSupportRole };
