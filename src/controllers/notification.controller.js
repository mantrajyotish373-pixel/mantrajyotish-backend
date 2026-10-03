const notificationService = require("../services/notification.service");

const send = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message || "Something went wrong" });

const list = async (req, res) => {
    try { res.json({ success: true, ...(await notificationService.list(req.user.userId, req.query)) }); } catch (e) { send(res, e); }
};

const unreadCount = async (req, res) => {
    try { res.json({ success: true, unread: await notificationService.unreadCount(req.user.userId) }); } catch (e) { send(res, e); }
};

const markRead = async (req, res) => {
    try { res.json({ success: true, updated: await notificationService.markRead(req.user.userId, (req.body || {}).ids) }); } catch (e) { send(res, e); }
};

module.exports = { list, unreadCount, markRead };
