const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const Admin = require("../models/admin.model");
const Role = require("../models/role.model");
const AuditLog = require("../models/auditLog.model");
const { MODULES, sanitizePermissions } = require("../config/permissions");
const { logAudit } = require("../utils/audit");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };
const validId = (id) => mongoose.Types.ObjectId.isValid(id);

const memberView = (a) => ({
    _id: a._id,
    name: a.name,
    email: a.email,
    role: a.role,
    roleId: a.roleId || null,
    roleName: a.role === "superadmin" ? "Super Admin" : (a.roleName || "Sub Admin"),
    permissions: a.permissions || [],
    status: a.status || "active",
    lastLoginAt: a.lastLoginAt || null,
    createdAt: a.createdAt
});

const getPermissionCatalog = (req, res) => res.json({ success: true, data: MODULES });

// ---------- Roles (named permission templates) ----------
const listRoles = async (req, res) => {
    const roles = await Role.find().sort({ createdAt: 1 }).lean();
    const counts = await Admin.aggregate([{ $match: { roleId: { $ne: null } } }, { $group: { _id: "$roleId", n: { $sum: 1 } } }]);
    const byRole = new Map(counts.map((c) => [String(c._id), c.n]));
    res.json({ success: true, data: roles.map((r) => ({ ...r, memberCount: byRole.get(String(r._id)) || 0 })) });
};

const createRole = async (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return fail(res, 400, "Role name is required");
    if (await Role.exists({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })) {
        return fail(res, 400, "A role with this name already exists");
    }
    const role = await Role.create({
        name,
        description: String(req.body.description || "").trim(),
        permissions: sanitizePermissions(req.body.permissions),
        createdBy: req.admin._id
    });
    audit(req, { action: "role.create", module: "team", statusCode: 201, summary: `Created role "${role.name}"`, details: { permissions: role.permissions } });
    res.status(201).json({ success: true, data: role });
};

const updateRole = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid role id");
    const role = await Role.findById(req.params.id);
    if (!role) return fail(res, 404, "Role not found");
    const before = { name: role.name, permissions: [...role.permissions] };
    if (req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return fail(res, 400, "Role name is required");
        role.name = name;
    }
    if (req.body.description !== undefined) role.description = String(req.body.description).trim();
    if (req.body.permissions !== undefined) role.permissions = sanitizePermissions(req.body.permissions);
    try { await role.save(); } catch (e) { return fail(res, 400, e.code === 11000 ? "A role with this name already exists" : e.message); }

    // Keep the label on existing members in sync; their individual permissions are NOT changed.
    if (role.name !== before.name) await Admin.updateMany({ roleId: role._id }, { roleName: role.name });
    audit(req, { action: "role.update", module: "team", statusCode: 200, summary: `Updated role "${role.name}"`, details: { before, after: { name: role.name, permissions: role.permissions } } });
    res.json({ success: true, data: role });
};

const deleteRole = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid role id");
    const role = await Role.findByIdAndDelete(req.params.id);
    if (!role) return fail(res, 404, "Role not found");
    await Admin.updateMany({ roleId: role._id }, { roleId: null }); // members keep their permissions and role label
    audit(req, { action: "role.delete", module: "team", statusCode: 200, summary: `Deleted role "${role.name}"` });
    res.json({ success: true, message: "Role deleted" });
};

// ---------- Team (sub-admin accounts) ----------
const listTeam = async (req, res) => {
    const members = await Admin.find().sort({ role: -1, createdAt: 1 }).select("-password").lean();
    res.json({ success: true, data: members.map(memberView) });
};

const resolveRole = async (roleId) => {
    if (!roleId) return null;
    if (!validId(roleId)) throw new Error("Invalid role");
    const role = await Role.findById(roleId).lean();
    if (!role) throw new Error("Role not found");
    return role;
};

const createMember = async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return fail(res, 400, "Name, email and password are required");
        if (String(password).length < 8) return fail(res, 400, "Password must be at least 8 characters");
        const normalizedEmail = String(email).toLowerCase().trim();
        if (await Admin.exists({ email: normalizedEmail })) return fail(res, 400, "An admin with this email already exists");

        const role = await resolveRole(req.body.roleId);
        const permissions = sanitizePermissions(req.body.permissions !== undefined ? req.body.permissions : role?.permissions);

        const member = await Admin.create({
            name: String(name).trim(),
            email: normalizedEmail,
            password: await bcrypt.hash(String(password), 10),
            role: "admin", // superadmin can never be created from the panel
            permissions,
            roleId: role?._id || null,
            roleName: role?.name || String(req.body.roleName || "").trim() || "Sub Admin",
            status: "active",
            createdBy: req.admin._id
        });
        audit(req, { action: "team.create", module: "team", statusCode: 201, summary: `Created sub-admin ${member.email} (${member.roleName})`, details: { permissions } });
        res.status(201).json({ success: true, data: memberView(member) });
    } catch (e) {
        fail(res, 400, e.message);
    }
};

const loadEditable = async (req, res) => {
    if (!validId(req.params.id)) { fail(res, 400, "Invalid id"); return null; }
    const member = await Admin.findById(req.params.id).select("+refreshSessions");
    if (!member) { fail(res, 404, "Team member not found"); return null; }
    if (member.role === "superadmin") { fail(res, 403, "The super admin account cannot be changed here"); return null; }
    return member;
};

const updateMember = async (req, res) => {
    try {
        const member = await loadEditable(req, res);
        if (!member) return;
        const before = { name: member.name, email: member.email, roleName: member.roleName, status: member.status, permissions: [...member.permissions] };

        if (req.body.name !== undefined) member.name = String(req.body.name).trim() || member.name;
        if (req.body.email !== undefined) {
            const e = String(req.body.email).toLowerCase().trim();
            if (e !== member.email) {
                if (await Admin.exists({ email: e })) return fail(res, 400, "An admin with this email already exists");
                member.email = e;
            }
        }
        if (req.body.roleId !== undefined) {
            const role = await resolveRole(req.body.roleId);
            member.roleId = role?._id || null;
            member.roleName = role?.name || String(req.body.roleName || "").trim() || member.roleName;
        }
        if (req.body.permissions !== undefined) member.permissions = sanitizePermissions(req.body.permissions);
        if (req.body.status !== undefined) {
            if (!["active", "disabled"].includes(req.body.status)) return fail(res, 400, "Invalid status");
            member.status = req.body.status;
        }
        // Disabled or permission-changed accounts lose any long-lived sessions immediately.
        if (member.status === "disabled") member.refreshSessions = [];
        await member.save();

        audit(req, {
            action: before.status !== member.status ? (member.status === "disabled" ? "team.disable" : "team.enable") : "team.update",
            module: "team", statusCode: 200,
            summary: `Updated sub-admin ${member.email}`,
            details: { before, after: { name: member.name, email: member.email, roleName: member.roleName, status: member.status, permissions: member.permissions } }
        });
        res.json({ success: true, data: memberView(member) });
    } catch (e) {
        fail(res, 400, e.message);
    }
};

const resetMemberPassword = async (req, res) => {
    const member = await loadEditable(req, res);
    if (!member) return;
    const password = String(req.body.password || "");
    if (password.length < 8) return fail(res, 400, "Password must be at least 8 characters");
    member.password = await bcrypt.hash(password, 10);
    member.refreshSessions = []; // force re-login everywhere
    await member.save();
    audit(req, { action: "team.reset_password", module: "team", statusCode: 200, summary: `Reset password for ${member.email}` });
    res.json({ success: true, message: "Password reset. The member has been logged out everywhere." });
};

const deleteMember = async (req, res) => {
    const member = await loadEditable(req, res);
    if (!member) return;
    if (String(member._id) === String(req.admin._id)) return fail(res, 400, "You cannot delete your own account");
    await member.deleteOne();
    audit(req, { action: "team.delete", module: "team", statusCode: 200, summary: `Deleted sub-admin ${member.email}` });
    res.json({ success: true, message: "Team member deleted" });
};

// ---------- Audit log ----------
const listAuditLogs = async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const filter = {};
    if (req.query.actorId && validId(req.query.actorId)) filter.actorId = req.query.actorId;
    if (req.query.module) filter.module = String(req.query.module);
    if (req.query.action) filter.action = String(req.query.action);
    if (req.query.from || req.query.to) {
        filter.createdAt = {};
        if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
        if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    if (req.query.q) {
        const q = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ summary: q }, { actorName: q }, { actorEmail: q }, { path: q }];
    }
    const [items, total] = await Promise.all([
        AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        AuditLog.countDocuments(filter)
    ]);
    res.json({ success: true, data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

module.exports = {
    getPermissionCatalog,
    listRoles, createRole, updateRole, deleteRole,
    listTeam, createMember, updateMember, resetMemberPassword, deleteMember,
    listAuditLogs
};
