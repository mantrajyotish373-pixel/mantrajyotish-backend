// Pushes "something changed on a complaint" to the people who care, over the existing Socket.IO server.
// Payloads carry only ids and a kind, never message text: clients re-read the complaint through the normal,
// authorised API. Failing to push never breaks the request that triggered it.
const safeIO = () => {
    try { return require("../config/socket").getIO(); } catch (e) { return null; }
};

const EVENT = "support:ticket";

/** kind: "created" | "message" | "status" */
const notify = ({ ticket, kind, toUser = true, toStaff = true }) => {
    const io = safeIO();
    if (!io || !ticket) return;
    const payload = { ticketId: String(ticket._id || ticket.id), number: ticket.number, status: ticket.status, kind, at: Date.now() };
    try {
        if (toStaff) io.to("staff:support").emit(EVENT, payload);
        if (toUser && ticket.user) io.to(`user:${String(ticket.user._id || ticket.user)}`).emit(EVENT, payload);
    } catch (e) {
        console.error("support realtime push failed:", e.message);
    }
};

module.exports = { notify, EVENT };
